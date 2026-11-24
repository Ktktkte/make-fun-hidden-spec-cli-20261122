// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, all four patch formats (unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits), matching lines at three tiers, and the all-or-nothing write. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in patch order, as [oldPath, newPath] pairs (for the `R` output lines). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own line break, the lines, and whether it ends with a break (section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function fileModel(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function fileText(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierFn(tier: number): (s: string) => string {
  return tier === 0 ? (s: string) => s : tier === 1 ? stripTrail : stripBoth;
}

/** One line of a replacement: a context line (index into O, written as the file's own line) or a new line. */
type NItem = { ctx: number } | { add: string };

/**
 * Find O in the file's lines at or after `from`, at the first tier (section 5) that has an occurrence.
 * With `onlyEnd`, only occurrences ending at the file's last line count. Null when no tier has one.
 */
function findTier(
  fileLines: string[],
  O: string[],
  strict: boolean,
  from: number,
  onlyEnd = false,
): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const f = tierFn(tier);
    const o = O.map(f);
    const at: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i++) {
      if (onlyEnd && i + O.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (f(fileLines[i + j]!) !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** Replace the O.length lines at `pos` by N, honouring section 5's context and tier-2 re-indent rules. */
function applyMatch(fileLines: string[], pos: number, O: string[], N: NItem[], tier: number): string[] {
  const F = leadWs(fileLines[pos] ?? '');
  const P = leadWs(O[0] ?? '');
  const out: string[] = [];
  for (const it of N) {
    if ('ctx' in it) {
      out.push(fileLines[pos + it.ctx]!);
    } else {
      let s = it.add;
      if (tier === 2 && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + O.length)];
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A `--- `/`+++ ` header path: text after the four characters, up to a tab, spaces removed, a/ or b/ stripped. */
function uPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface UBody {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl: boolean;
  rawEmpty: boolean;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

/** Apply one section's hunks to a file's text, in order, tracking the cumulative length delta (section 6). */
function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const m = fileModel(text);
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NItem[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        O.push(b.text);
        N.push({ ctx: O.length - 1 });
      } else if (b.kind === 'del') {
        O.push(b.text);
      } else {
        N.push({ add: b.text });
      }
    }
    // The hunk's last context or `+` body line decides the final break when the hunk touches the file's end.
    let lastCp: UBody | null = null;
    for (const b of h.body) if (b.kind !== 'del') lastCp = b;
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, m.lines.length));
      const adds = N.map((it) => (it as { add: string }).add);
      const atEnd = at === m.lines.length;
      m.lines.splice(at, 0, ...adds);
      if (atEnd && lastCp !== null) m.final = !lastCp.noNl;
    } else {
      const found = findTier(m.lines, O, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.at) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const runsToEnd = pos + O.length === m.lines.length;
      m.lines = applyMatch(m.lines, pos, O, N, found.tier);
      if (runsToEnd && lastCp !== null) m.final = !lastCp.noNl;
    }
    d += N.length - O.length;
  }
  return fileText(m);
}

function uSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath ?? sec.renameOld ?? sec.gitOld;
    const newP = sec.newPath ?? sec.renameNew ?? sec.gitNew;
    const isCreate = sec.create || sec.oldPath === '/dev/null';
    const isDelete = sec.del || sec.newPath === '/dev/null';
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let lastAdd: UBody | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'add') {
            lines.push(b.text);
            lastAdd = b;
          }
        }
      }
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (lastAdd !== null && lastAdd.noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, applyHunks(before, sec.hunks, strict, oldP));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: 'ctx' | 'del' | 'add'; text: string; rawEmpty: boolean }[];
}

const v4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Read a V4A patch (section 8) into edits. Throws Exit2 on a parse fault. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i++;
      const items: { text: string; rawEmpty: boolean }[] = [];
      while (i < last && !v4aSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b.startsWith('+')) items.push({ text: b.slice(1), rawEmpty: false });
        else if (b === '' || b === ' ') items.push({ text: '', rawEmpty: true });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (items.length > 0 && items[items.length - 1]!.rawEmpty) items.pop();
      const content = items.map((x) => x.text);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i++;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      while (i < last && !v4aSectionStart(lines[i]!)) {
        const b = lines[i]!;
        if (b.startsWith('@@')) {
          cur = { anchor: b.slice(2).trim() || null, eof: false, body: [] };
          chunks.push(cur);
          i++;
          continue;
        }
        if (b.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({
            kind: b === '' || b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'del' : 'add',
            text: b === '' ? '' : b.slice(1),
            rawEmpty: b === '' || b === ' ',
          });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.rawEmpty) lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const m = fileModel(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let foundAt = -1;
            for (const tier of strict ? [0] : [0, 1, 2]) {
              const f = tierFn(tier);
              const want = f(ch.anchor);
              for (let j = cursor; j < m.lines.length; j++) {
                if (f(m.lines[j]!) === want) {
                  foundAt = j;
                  break;
                }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', p);
            cursor = foundAt + 1;
          }
          const O: string[] = [];
          const N: NItem[] = [];
          for (const b of ch.body) {
            if (b.kind === 'ctx') {
              O.push(b.text);
              N.push({ ctx: O.length - 1 });
            } else if (b.kind === 'del') {
              O.push(b.text);
            } else {
              N.push({ add: b.text });
            }
          }
          if (O.length === 0) {
            const at = ch.eof ? m.lines.length : Math.min(cursor, m.lines.length);
            const adds = N.map((it) => (it as { add: string }).add);
            m.lines.splice(at, 0, ...adds);
            cursor = at + adds.length;
          } else {
            const found = findTier(m.lines, O, strict, cursor, ch.eof);
            if (found === null || found.at.length === 0) throw new Fail('no-match', p);
            const pos = found.at[0]!;
            m.lines = applyMatch(m.lines, pos, O, N, found.tier);
            cursor = pos + N.length;
          }
        }
        const out = fileText(m);
        if (mv !== null) {
          tree.now.set(mv, out);
          tree.now.set(p, null);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** Read SEARCH/REPLACE blocks (section 7) into edits. Throws Exit2 on a parse fault. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const m = fileModel(before);
      const found = findTier(m.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const N: NItem[] = newLines.map((t) => ({ add: t }));
      m.lines = applyMatch(m.lines, found.at[0]!, oldLines, N, found.tier);
      tree.now.set(p, fileText(m));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** Read a unified diff (section 6) into edits. Throws Exit2 on a parse fault. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const gitRe = /^diff --git a\/(.+?) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let sec: USection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: null, newPath: null, renameOld: null, renameNew: null, gitOld: m[1]!, gitNew: m[2]!, create: false, del: false, hunks: [] };
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: null, newPath: null, renameOld: null, renameNew: null, gitOld: null, gitNew: null, create: false, del: false, hunks: [] };
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    let sawHunk = false;
    while (i < lines.length) {
      const l = lines[i]!;
      if (!sawHunk) {
        if (l.startsWith('--- ') && sec.oldPath === null) {
          if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
          sec.oldPath = uPath(l);
          sec.newPath = uPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        if (l.startsWith('rename from ')) {
          sec.renameOld = l.slice('rename from '.length);
          i++;
          continue;
        }
        if (l.startsWith('rename to ')) {
          sec.renameNew = l.slice('rename to '.length);
          i++;
          continue;
        }
        if (l.startsWith('new file mode')) {
          sec.create = true;
          i++;
          continue;
        }
        if (l.startsWith('deleted file mode')) {
          sec.del = true;
          i++;
          continue;
        }
        if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (!l.startsWith('@@')) {
          i++;
          continue;
        }
      }
      if (l.startsWith('@@')) {
        const hm = hunkRe.exec(l);
        if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
        sawHunk = true;
        const hunk: UHunk = { a: parseInt(hm[1]!, 10), body: [] };
        i++;
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '') {
            hunk.body.push({ kind: 'ctx', text: '', noNl: false, rawEmpty: true });
            i++;
            continue;
          }
          const c = b[0]!;
          if (c === ' ' || c === '-' || c === '+') {
            hunk.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: b.slice(1), noNl: false, rawEmpty: c === ' ' && b.length === 1 });
            i++;
            continue;
          }
          if (c === '\\') {
            const prev = hunk.body[hunk.body.length - 1];
            if (prev !== undefined) prev.noNl = true;
            i++;
            continue;
          }
          break;
        }
        while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.rawEmpty) hunk.body.pop();
        sec.hunks.push(hunk);
        continue;
      }
      break;
    }
    sections.push(sec);
  }
  return sections.map((s) => uSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const rows: { key: string; line: string }[] = [];
  const paired = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      paired.add(o);
      paired.add(n);
    }
  }
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const lines0 = rows.map((r) => r.line);
  return { code: 0, out: [...lines0, `ok: ${lines0.length} ${lines0.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
