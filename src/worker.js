importScripts('engine.js', 'openings.js', 'review.js', 'settings.js');
const engine = new NyxChess.Engine();
let reviewCancelled = false;
self.onmessage = async ({ data }) => {
  try {
    if (data?.type === 'review') {
      reviewCancelled = false;
      const review = await NyxReview.reviewGame(engine, {
        historyFens: Array.isArray(data.historyFens) ? data.historyFens : [],
        side: data.side,
        depth: data.depth,
        nodeLimit: data.nodeLimit,
        timeMs: data.timeMs,
        shouldStop: () => reviewCancelled,
        onProgress: ({ done, total }) => {
          self.postMessage({ type: 'review-progress', id: data.id, done, total });
        }
      });
      self.postMessage({ type: 'review-result', id: data.id, review });
      return;
    }
    const options = NyxSettings.engineOptions(data.options);
    const result = NyxOpenings.pick(data.fen, { ...options, bookSeed: data.bookSeed }) || await engine.think(data.fen, {
      ...options,
      historyFens: Array.isArray(data.historyFens) ? data.historyFens : [],
      rootSlice: data.rootSlice,
      blunder: data.blunder === true,
      blunderMin: data.blunderMin,
      blunderMax: data.blunderMax,
      ttLimit: data.options?.ttLimit
    });
    self.postMessage({ type: 'result', id: data.id, fen: data.fen, result });
  } catch (error) {
    self.postMessage({ type: data?.type === 'review' ? 'review-result' : 'error', id: data?.id, error: error.message });
  }
};
