# Sokoban Solver

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![make.fun](https://make.fun/badge/makefun.svg)](https://make.fun)

A push-optimal Sokoban solver, built for [make.fun's Sokoban solver bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121). It answers a whole set of 5 levels in one run, in the fewest pushes.

## How it works

Every level is a hallway with rooms off it, so a level is solved room by room and
the pushes add up to the level's optimum:

- **Rooms.** The dead squares of the player's row (the hallway) are cut out of
  the floor; each part left holding boxes is a room.
- **Push search.** A room is searched over pushes, not steps: a state is the
  boxes plus the player's reachable region. A* with a min-cost-matching
  heuristic (each box's fewest pushes to a goal, over the optimal box-to-goal
  assignment) finds the push-optimal answer, pruning dead squares and frozen
  2x2 blocks. Plain push-BFS and greedy best-first are the fallbacks.
- **Deterministic.** No clock, no randomness, work budgets in states: two runs
  write the same bytes. A set of 5 levels solves in well under a second.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `level.txt` under `$MAKEFUN_INPUT_DIR/<id>/` and writes
`$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` (the player's moves in LURD) for every
instance. Node 22, no dependencies, no install step.

## Results

On the kit's practice set it matches the push-optimal count on all 5 levels
(13, 16, 29, 47, 60 pushes) for a score of 1,000,000, and the same on 20
further sets drawn with the kit's own generator.
