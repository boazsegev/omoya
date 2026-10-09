---
name: programming-optimization
description: "This skill should be used when profiling or optimizing algorithms, latency, throughput, memory use, or hot paths, or when deciding whether a performance change is justified."
---

# Optimizing Code

## Set the Target First

Before changing code, record: the metric (p50/p95/p99 latency, throughput, CPU, peak memory, bundle size), a numeric target (`p99 < 50 ms at 1000 concurrent users`), a realistic workload and the measurement method. Stop when the target is met. If no target is given and the work is Tier 3, ask for one.

## Fix by Tier, Macro to Micro

| Tier | Examples | Measurement |
|---|---|---|
| 1 Design | algorithm, data structure, round trips, memory layout | not required |
| 2 Implementation | allocation churn, buffering, batching, caching, duplicate parsing | light check |
| 3 Micro | branch shaping, SIMD, prefetch, PGO/LTO, runtime hints | before/after benchmark required |

Fix these on sight, without profiling:
- nested-loop membership scans → hash set/map;
- queries or network calls inside loops (N+1) → batch;
- repeated recomputation → precompute or memoize with explicit invalidation;
- byte- or row-at-a-time I/O → buffered bulk I/O;
- pointer-chasing traversal (linked lists, trees) in hot loops → contiguous arrays;
- blocking work on a request, UI or event-loop path → async or background job.

Apply Tier 2 as normal craft: reuse and pre-size buffers, filter early, put cheap guards before expensive work, avoid repeated serialization.

## Measure Tier 3

- Bottleneck unknown: profile under realistic load; work only on the top 1–3 hotspots.
- Hot path known: benchmark that exact path before and after; skip broad profiling.
- Memory grows: use a heap or allocation profiler to find what is retained.
- Latency spikes: capture p95/p99 plus lock contention, GC pauses and event-loop delay.

Benchmark discipline: change one thing at a time; warm up; use realistic data sizes; run enough iterations to separate signal from noise; report median and p95/p99, not just the mean; benchmark optimized builds. Keep a Tier 3 change only if the target metric improves and tests pass; otherwise revert it.

## Report

State: target and workload; the tier of each bottleneck; changes in order of leverage; before/after numbers for Tier 3; correctness checks run; ideas tried and reverted.
