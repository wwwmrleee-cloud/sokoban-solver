// sokoban-solver: a push-optimal Sokoban solver.
//
// Each level is a hallway with rooms off it (make.fun's generator), so a level is
// solved room by room: every room is a small Sokoban of its own, solved in the
// fewest pushes, and the pushes add up to the level's optimum. A room is searched
// over pushes (not steps): a state is the boxes plus the player's reachable
// region, and A* with a min-cost-matching heuristic (each box's fewest pushes to
// a goal, over the optimal box-to-goal assignment) finds the push-optimal answer
// while pruning dead squares and frozen 2x2 blocks. No clock, no randomness:
// two runs write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** [dx, dy, step letter, push letter]. */
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
] as const;

/** Search budgets in states, never the clock: the same work every run. */
const ASTAR_CAP = 150_000;
const BFS_CAP = 250_000;
const GREEDY_CAP = 250_000;

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text. Short rows and the outer frame read as walls. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a box can be pushed from onto some goal: pull the goals back over
 * open floor (a box at y came from y - d when y - d and y - 2d are floor).
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue = [...b.goals];
  for (const g of b.goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` around walls and boxes; the lowest. */
function reach(b: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - b.w : k === 1 ? p + b.w : k === 2 ? p - 1 : p + 1;
      if (!b.wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower letters. */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how: string[] = new Array(b.w * b.h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes. */
function frozenBlock(b: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - b.w, t - b.w - 1]) {
    const c = a + b.w;
    const d = c + 1;
    if (!(b.wall[a] || occupied[a]) || !(b.wall[a + 1] || occupied[a + 1]) || !(b.wall[c] || occupied[c]) || !(b.wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[a + 1] && !goal[a + 1]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box
 * there reaches no goal) out of the floor, and each part left holding a box is a
 * room. Null when the level is no set of rooms.
 */
function roomsOf(b: Board): { squares: number[]; boxes: number[]; goals: number[]; done: boolean }[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.w * b.h);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) if (!b.wall[i] && !live[i]) cut[i] = 1;
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.w * b.h).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[]; done: boolean }[] = [];
  for (let s = 0; s < b.w * b.h; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * b.w + dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const x of b.boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of b.goals) if (part[g] >= 0) rooms[part[g]!]!.goals.push(g);
  if (b.goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Push distances: dist[g][c] is the fewest pushes moving a box from c onto goal g,
 * ignoring the other boxes (a lower bound, so an admissible heuristic). Found by
 * a backwards search from each goal: a box at y came from y - d when y - d and
 * y - 2d are floor.
 */
function pushDistances(b: Board): Int32Array[] {
  return b.goals.map((g) => {
    const dist = new Int32Array(b.w * b.h).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const y = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * b.w + dx;
        const x = y - d;
        if (b.wall[x] || b.wall[x - d] || dist[x] !== -1) continue;
        dist[x] = dist[y]! + 1;
        queue.push(x);
      }
    }
    return dist;
  });
}

/** The cheapest assignment of boxes to goals by push distance, or Infinity. */
function matchingHeuristic(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  // Many boxes (a whole level, not a room): the sum of each box's nearest goal is
  // a cheaper lower bound than the assignment, and just as admissible.
  if (n > 5) {
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (const d of dist) if (d[b]! >= 0 && d[b]! < m) m = d[b]!;
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  }
  const order = boxes.map((_, i) => i);
  let best = Infinity;
  const permute = (k: number, acc: number): void => {
    if (acc >= best) return;
    if (k === n) {
      best = acc;
      return;
    }
    for (let i = k; i < n; i++) {
      [order[k], order[i]] = [order[i]!, order[k]!];
      const d = dist[order[k]!]![boxes[k]!];
      if (d !== undefined && d >= 0) permute(k + 1, acc + d);
      [order[k], order[i]] = [order[i]!, order[k]!];
    }
  };
  permute(0, 0);
  return best;
}

/** A state's key: its boxes and its player region's lowest square. */
const keyOf = (boxes: number[], low: number): string => low + '|' + boxes.join(',');

/**
 * One room (or a whole level) solved in the fewest pushes: A* over pushes with the
 * matching heuristic, then plain push-BFS, then greedy best-first. Returns the
 * moves, or '' when nothing is found.
 */
function searchPushOptimal(sub: Board, maxStates: number, mode: 'astar' | 'bfs' | 'greedy'): string | null {
  const { w, wall } = sub;
  const size = w * sub.h;
  const goal = new Uint8Array(size);
  for (const g of sub.goals) goal[g] = 1;
  const live = liveSquares(sub);
  const dist = pushDistances(sub);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (sub.boxes.some((b) => !live[b])) return null;

  const stBoxes: number[][] = [sub.boxes.slice().sort((a, b) => a - b)];
  const stPlayer: number[] = [sub.player];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stTo: number[] = [-1];
  const stDir: number[] = [-1];
  const stG: number[] = [0];
  const best = new Map<string, number>();
  for (const b of sub.boxes) occupied[b] = 1;
  const low0 = reach(sub, occupied, sub.player, seen, ++stamp, stack);
  for (const b of sub.boxes) occupied[b] = 0;
  best.set(keyOf(stBoxes[0]!, low0), 0);
  if (solved(stBoxes[0]!)) return '';

  // The open list: [priority, heuristic, sequence, state], lowest first.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const h0 = matchingHeuristic(stBoxes[0]!, dist);
  if (h0 === Infinity) return null;
  const prio = (g: number, h: number): number => (mode === 'astar' ? g + h : mode === 'bfs' ? g : h);
  heap.push([prio(0, h0), h0, seq++, 0]);
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let found = -1;
  let expanded = 0;
  while (heap.length > 0 && expanded < maxStates) {
    const [, , , s] = heapPop();
    const boxes = stBoxes[s]!;
    const g = stG[s]!;
    for (const b of boxes) occupied[b] = 1;
    const low = reach(sub, occupied, stPlayer[s]!, seen, ++stamp, stack);
    if (best.get(keyOf(boxes, low)) !== g) {
      for (const x of boxes) occupied[x] = 0;
      continue;
    }
    expanded++;
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(sub, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          const nlow = reach(sub, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, nlow);
          const seenG = best.get(key);
          if (seenG === undefined || seenG > g + 1) h = matchingHeuristic(next, dist);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || h === Infinity) continue;
        const seenG = best.get(key);
        if (seenG !== undefined && seenG <= g + 1) continue;
        if (stBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g + 1);
        stBoxes.push(next);
        stPlayer.push(b);
        stParent.push(s);
        stFrom.push(b);
        stTo.push(t);
        stDir.push(di);
        stG.push(g + 1);
        if (solved(next)) {
          found = stBoxes.length - 1;
          break;
        }
        heapPush([prio(g + 1, h), h, seq++, stBoxes.length - 1]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = sub.player;
  let boxes = sub.boxes.slice().sort((a, b) => a - b);
  for (const s of path) {
    const from = stFrom[s]!;
    const to = stTo[s]!;
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(sub, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[stDir[s]!]![3];
    player = from;
    boxes = stBoxes[s]!;
  }
  return moves;
}

/** The level solved room by room, the other rooms' boxes standing as walls. */
function solve(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    return searchPushOptimal(level, BFS_CAP, 'astar') ?? searchPushOptimal(level, BFS_CAP, 'bfs') ?? searchPushOptimal(level, GREEDY_CAP, 'greedy') ?? '';
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Board = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved =
      searchPushOptimal(sub, ASTAR_CAP, 'astar') ??
      searchPushOptimal(sub, BFS_CAP, 'bfs') ??
      searchPushOptimal(sub, GREEDY_CAP, 'greedy');
    if (solved === null) return '';
    moves += solved;
    // The player's square after the room's moves.
    for (const ch of solved.toLowerCase()) player += ch === 'u' ? -level.w : ch === 'd' ? level.w : ch === 'l' ? -1 : 1;
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
