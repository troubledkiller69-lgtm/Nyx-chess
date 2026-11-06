// Only injected by the local preview server with ?demo.
window.chrome = {
  tabs: {
    query: async () => [{ id: 1 }],
    sendMessage: async (_id, request) => {
      const data = window.__previewState ||= {
        ok: true, settings: { ...NyxSettings.defaults }, state: { available: true, turn: 'w' },
        phase: 'idle', message: 'Board connected. Ready when you are.', running: false,
        result: { move: 'f2f4', source: 'book', opening: 'King’s Gambit', score: null, nodes: 0, depth: 0, time: 0 }
      };
      if (request.type === 'configure') data.settings = request.settings;
      if (request.type === 'start') { data.running = true; data.phase = 'thinking'; data.message = 'White to move. Thinking…'; }
      if (request.type === 'stop') { data.running = false; data.phase = 'idle'; data.message = 'Stopped.'; }
      if (request.type === 'once') data.message = 'Move played.';
      return data;
    }
  }
};
