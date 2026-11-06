(() => {
  'use strict';
  let port;
  let workers = [];
  let active = null;
  let activeToken = 0;
  let safety;
  let reviewWorker = null;
  let reviewId = null;
  const MATE = 100000;

  function poolSize() {
    // Leave a core for the page and the tab's own rendering. On a 4-core
    // machine that means three search workers; on small machines, one.
    const cores = typeof navigator !== 'undefined' ? Number(navigator.hardwareConcurrency) || 4 : 1;
    return cores > 1 ? Math.max(1, Math.min(4, cores - 1)) : 1;
  }

  function spawn(index) {
    const worker = new Worker('worker.js');
    worker.onmessage = (event) => {
      if (!workers.includes(worker)) return;
      onWorkerMessage(index, worker, event.data);
    };
    worker.onerror = (event) => {
      // A worker terminated during importScripts can still emit its load error
      // after the host has already spawned a replacement pool. Ignore errors
      // from workers that no longer belong to the active pool instead of
      // failing the new search with a stale importScripts message.
      if (!active || !workers.includes(worker)) return;
      finishWithError(event.message || 'Engine worker failed.');
    };
    return worker;
  }

  function ensureWorkers(count) {
    while (workers.length < count) workers.push(spawn(workers.length));
    return workers;
  }

  function stopWorkers() {
    for (const worker of workers) {
      // Detach before terminating so a load error from a worker that is being
      // replaced cannot be attributed to the next search.
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.terminate(); } catch { /* already gone */ }
    }
    workers = [];
  }

  function stopReview() {
    if (reviewWorker) {
      try { reviewWorker.terminate(); } catch { /* already gone */ }
    }
    reviewWorker = null;
    reviewId = null;
  }

  function cancelReview() {
    const id = reviewId;
    stopReview();
    if (id !== null) port?.postMessage({ type: 'review-cancelled', id });
  }

  function clearSafety() {
    if (safety !== undefined && typeof clearTimeout === 'function') clearTimeout(safety);
    safety = undefined;
  }

  function armSafety(ms, token) {
    clearSafety();
    if (typeof setTimeout !== 'function') return;
    safety = setTimeout(() => {
      if (token !== activeToken || !active) return;
      finishWithError('Engine search timed out.');
    }, ms);
  }

  function reset(count = 1) {
    activeToken++;
    active = null;
    clearSafety();
    stopReview();
    stopWorkers();
    ensureWorkers(count);
  }

  function finishWithError(message) {
    if (!active) return;
    port?.postMessage({ id: active.id, fen: active.fen, error: message });
    active = null;
    clearSafety();
  }

  function finishSearch() {
    if (!active) return;
    const results = active.results.filter((result) => result && !result.error);
    const errors = active.results.filter((result) => result?.error);
    // A single worker has already selected the move (including strength,
    // variety and deliberate errors). Root merging would replace that choice
    // with lines[0] and silently turn Human mode into maximum-strength play.
    if (active.total === 1) {
      if (!results.length) return finishWithError(errors[0]?.error || 'Engine returned no search result.');
      port?.postMessage({ type: 'result', id: active.id, fen: active.fen, result: results[0] });
      active = null;
      clearSafety();
      return;
    }
    const usable = results.filter((result) => Array.isArray(result.lines) && result.lines.length);
    if (!usable.length) {
      finishWithError(errors[0]?.error || 'Engine returned no search result.');
      return;
    }

    // A book move is identical in every partition. Return it once.
    const book = usable.find((result) => result.source === 'book');
    if (book) {
      port?.postMessage({ type: 'result', id: active.id, fen: active.fen, result: book });
      active = null;
      clearSafety();
      return;
    }

    const lines = [];
    let depth = 0, nodes = 0, time = 0;
    for (const result of usable) {
      depth = Math.max(depth, result.depth || 0);
      nodes += result.nodes || 0;
      time = Math.max(time, result.time || 0);
      for (const line of result.lines) lines.push(line);
    }
    // Ties go to the deeper search; otherwise the highest exact score wins.
    lines.sort((a, b) => b.score - a.score || b.depth - a.depth);
    const top = lines[0];
    const topResult = usable.find((result) => result.move === top.move) || usable[0];
    const mate = Math.abs(top.score) > MATE - 100
      ? Math.sign(top.score) * Math.ceil((MATE - Math.abs(top.score)) / 2)
      : null;
    const result = {
      best: topResult.best ?? top.best ?? 0,
      bestMove: topResult.bestMove,
      move: top.move,
      score: top.score,
      depth,
      nodes,
      time,
      scoreSource: 'search',
      source: 'search',
      mate,
      // Preserve genuine metadata instead of dropping it in the merge. Never
      // invent exactness: it is true only when every contributing root search
      // reported exact scores.
      exactScores: usable.every((entry) => entry.exactScores === true),
      blundered: usable.some((entry) => entry.blundered === true),
      blunderLoss: topResult.blunderLoss,
      gap: topResult.gap,
      legalMoves: topResult.legalMoves,
      lines: lines.slice(0, 3).map(({ move, score, best }) => ({ move, score, best }))
    };
    port?.postMessage({ type: 'result', id: active.id, fen: active.fen, result });
    active = null;
    clearSafety();
  }

  function onWorkerMessage(index, worker, data) {
    if (!active || !data || data.id !== active.id) return;
    if (data.error) {
      if (!active.results[index]) active.results[index] = { error: data.error };
      active.received++;
      if (active.received >= active.total) finishSearch();
      return;
    }
    if (data.type !== 'result' || active.results[index]) return;
    active.results[index] = data.result;
    active.received++;
    if (active.received >= active.total) finishSearch();
  }

  function startReview(data) {
    // Review is deliberately background work. It must never take a core away
    // from a live game search, so the host refuses while a search is active.
    if (active) {
      port?.postMessage({ type: 'review-result', id: data.id, error: 'Engine is busy with a game search.' });
      return;
    }
    stopReview();
    const id = data.id;
    let worker;
    try {
      worker = new Worker('worker.js');
    } catch (error) {
      port?.postMessage({ type: 'review-result', id, error: error.message || 'Review worker failed.' });
      return;
    }
    reviewWorker = worker;
    reviewId = id;
    worker.onmessage = (event) => {
      const message = event?.data;
      if (reviewWorker !== worker || !message || message.id !== id) return;
      if (message.type === 'review-progress') {
        port?.postMessage(message);
        return;
      }
      if (message.type === 'review-result') {
        port?.postMessage(message);
        stopReview();
        return;
      }
      if (message.error) {
        port?.postMessage({ type: 'review-result', id, error: message.error });
        stopReview();
      }
    };
    worker.onerror = (event) => {
      if (reviewWorker !== worker) return;
      port?.postMessage({ type: 'review-result', id, error: event?.message || 'Review worker failed.' });
      stopReview();
    };
    worker.postMessage({ ...data, type: 'review' });
  }

  function think(data) {
    const options = data.options || {};
    // Ruthless is the maximum-strength mode, so it gets every core. Human
    // mode deliberately stays single-threaded: its move selection needs one
    // exact root score list, not a partition of it.
    const count = options.mode === 'ruthless' && options.parallel !== false ? poolSize() : 1;
    ensureWorkers(count);
    active = {
      id: data.id,
      fen: data.fen,
      total: count,
      results: new Array(count),
      received: 0
    };
    const token = ++activeToken;
    const budget = Math.max(50, Number(options.timeMs) || 450);
    armSafety(budget + 15000, token);
    for (let index = 0; index < count; index++) {
      workers[index].postMessage({
        ...data,
        rootSlice: { index, count },
        // More workers means more tables; keep each one lean so four cores do
        // not turn a bullet search into a garbage-collection contest.
        options: { ...options, ttLimit: count > 1 ? 60000 : 160000 }
      });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent || !/^https:\/\/(www\.)?chess\.com$/.test(event.origin)) return;
    if (event.data?.type !== 'nyx-engine-connect' || !event.ports[0] || port) return;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data.type === 'cancel') {
        cancelReview();
        reset(poolSize());
      } else if (data.type === 'review') startReview(data);
      else if (data.type === 'review-cancel') cancelReview();
      else if (data.type === 'think') think(data);
    };
    // Prewarm the pool so the first ruthless move does not pay script parse
    // time on top of its search budget.
    reset(poolSize());
    port.postMessage({ type: 'ready' });
  });
})();
