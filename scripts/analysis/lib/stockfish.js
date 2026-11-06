'use strict';

// Minimal, defensive UCI adapter for an external Stockfish process.
//
// This module deliberately knows nothing about Nyx's engine or evaluation. It
// only speaks UCI, records what the external process reported, and makes sure
// the child is stopped when a search times out, is cancelled, or fails.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const DEFAULT_TIMEOUT_MS = 15000;
const STOP_GRACE_MS = 1000;

class UciError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UciError';
    Object.assign(this, details);
  }
}

class UciTimeoutError extends UciError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'UciTimeoutError';
  }
}

class UciAbortError extends UciError {
  constructor(message = 'Stockfish analysis was cancelled', details = {}) {
    super(message, details);
    this.name = 'UciAbortError';
  }
}

function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.name === 'UciAbortError'));
}

function parseOptionLine(line) {
  // option name Threads type spin default 1 min 1 max 1024
  const match = /^option name (.+?) type (\w+)(.*)$/.exec(line);
  if (!match) return null;
  const option = { name: match[1], type: match[2] };
  const rest = match[3] || '';
  for (const key of ['default', 'min', 'max']) {
    const found = new RegExp(`(?:^|\\s)${key}\\s+(.+?)(?=\\s(?:default|min|max|var)\\s|$)`).exec(rest);
    if (found) option[key] = found[1];
  }
  const vars = [];
  const varRe = /(?:^|\s)var\s+(.+?)(?=\s(?:default|min|max|var)\s|$)/g;
  let varMatch;
  while ((varMatch = varRe.exec(rest))) vars.push(varMatch[1]);
  if (vars.length) option.vars = vars;
  return option;
}

function parseInfo(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info') return null;
  const info = {
    depth: null,
    seldepth: null,
    multipv: 1,
    nodes: null,
    nps: null,
    hashfull: null,
    tbhits: null,
    timeMs: null,
    score: null,
    pv: [],
    wdl: null,
    string: null,
    currmove: null
  };
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'string') {
      info.string = tokens.slice(i + 1).join(' ');
      break;
    }
    if (token === 'score') {
      const type = tokens[i + 1];
      const value = Number(tokens[i + 2]);
      if ((type === 'cp' || type === 'mate') && Number.isFinite(value)) {
        const bound = tokens[i + 3] === 'lowerbound' || tokens[i + 3] === 'upperbound'
          ? tokens[i + 3]
          : null;
        info.score = { type, value, bound, raw: `${type} ${value}${bound ? ` ${bound}` : ''}` };
      }
      i += boundLength(tokens, i);
      continue;
    }
    if (token === 'pv') {
      info.pv = tokens.slice(i + 1);
      break;
    }
    if (token === 'wdl') {
      const values = tokens.slice(i + 1, i + 4).map(Number);
      if (values.every(Number.isFinite)) info.wdl = values;
      i += 3;
      continue;
    }
    if (token === 'currmove') {
      info.currmove = tokens[i + 1] || null;
      i += 1;
      continue;
    }
    if (token === 'depth') info.depth = Number(tokens[++i]);
    else if (token === 'seldepth') info.seldepth = Number(tokens[++i]);
    else if (token === 'multipv') info.multipv = Number(tokens[++i]);
    else if (token === 'nodes') info.nodes = Number(tokens[++i]);
    else if (token === 'nps') info.nps = Number(tokens[++i]);
    else if (token === 'hashfull') info.hashfull = Number(tokens[++i]);
    else if (token === 'tbhits') info.tbhits = Number(tokens[++i]);
    else if (token === 'time') info.timeMs = Number(tokens[++i]);
  }
  return info;
}

function boundLength(tokens, scoreIndex) {
  const next = tokens[scoreIndex + 3];
  return next === 'lowerbound' || next === 'upperbound' ? 3 : 2;
}

class Stockfish {
  constructor(executable, options = {}) {
    if (!executable || typeof executable !== 'string') {
      throw new UciError('A Stockfish executable path is required');
    }
    this.executable = path.resolve(executable);
    this.args = Array.isArray(options.args) ? options.args.slice() : [];
    this.env = options.env ? { ...process.env, ...options.env } : process.env;
    this.cwd = options.cwd || undefined;
    this.defaultTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.startTimeoutMs = Number(options.startTimeoutMs) > 0 ? Number(options.startTimeoutMs) : 10000;
    this.onLine = typeof options.onLine === 'function' ? options.onLine : null;
    this.onStderr = typeof options.onStderr === 'function' ? options.onStderr : null;
    this.child = null;
    this.id = { name: null, author: null };
    this.options = new Map();
    this.lines = [];
    this.stderr = '';
    this.busy = false;
    this.closed = false;
    this._waiter = null;
    this._analysis = null;
    this._decoder = new StringDecoder('utf8');
    this._buffer = '';
  }

  hasOption(name) {
    return this.options.has(String(name).toLowerCase());
  }

  get version() {
    return this.id.name || null;
  }

  async start() {
    if (this.child) return this;
    if (this.closed) throw new UciError('Stockfish adapter is already closed');
    let child;
    try {
      child = spawn(this.executable, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.env,
        cwd: this.cwd
      });
    } catch (error) {
      throw new UciError(`Could not start Stockfish at "${this.executable}": ${error.message}`, { cause: error });
    }
    this.child = child;
    child.stdin.on('error', () => { /* surfaced through command timeouts / exit */ });
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderr = (this.stderr + text).slice(-16384);
      if (this.onStderr) this.onStderr(text);
    });
    child.on('error', (error) => {
      this._fail(new UciError(`Stockfish process error: ${error.message}`, { cause: error }));
    });
    child.on('exit', (code, signal) => {
      if (!this.closed) {
        this._fail(new UciError(
          `Stockfish exited unexpectedly (code ${code === null ? 'null' : code}, signal ${signal || 'none'})` +
          (this.stderr ? `: ${this.stderr.trim().slice(-500)}` : '')
        ));
      }
    });

    // Handshake. The waiter is installed before writing, so a fast process
    // cannot race us.
    const uciOk = this._waitFor((line) => line === 'uciok', this.startTimeoutMs, 'uci handshake');
    this._write('uci');
    await uciOk;
    const ready = this._waitFor((line) => line === 'readyok', this.startTimeoutMs, 'isready handshake');
    this._write('isready');
    await ready;
    return this;
  }

  async setOption(name, value) {
    this._assertRunning();
    if (value === undefined || value === null || value === true) {
      this._write(`setoption name ${name}`);
    } else {
      this._write(`setoption name ${name} value ${value}`);
    }
    const ready = this._waitFor((line) => line === 'readyok', this.defaultTimeoutMs, `readyok after setoption ${name}`);
    this._write('isready');
    await ready;
  }

  async isReady(timeoutMs = this.defaultTimeoutMs) {
    this._assertRunning();
    const ready = this._waitFor((line) => line === 'readyok', timeoutMs, 'isready');
    this._write('isready');
    await ready;
  }

  async newGame() {
    this._assertRunning();
    this._write('ucinewgame');
    await this.isReady();
  }

  // Search one position. The returned score is from the root side to move,
  // exactly as UCI reports it; callers must not flip the sign.
  async analyze(input = {}) {
    this._assertRunning();
    if (this.busy) throw new UciError('Stockfish adapter is already analyzing; calls must be sequential');

    const fen = input.fen || START_FEN;
    const moves = Array.isArray(input.moves) ? input.moves.map(String) : [];
    const searchmoves = Array.isArray(input.searchmoves) ? input.searchmoves.map(String) : [];
    const depth = Number(input.depth) > 0 ? Math.floor(Number(input.depth)) : null;
    const nodes = Number(input.nodes) > 0 ? Math.floor(Number(input.nodes)) : null;
    const movetimeMs = Number(input.movetimeMs) > 0 ? Math.floor(Number(input.movetimeMs)) : null;
    const timeoutMs = Number(input.timeoutMs) > 0
      ? Math.floor(Number(input.timeoutMs))
      : Math.max(this.defaultTimeoutMs, (depth || 1) * 5000 + (movetimeMs || 0));
    const signal = input.signal || null;
    const clearHash = Boolean(input.clearHash);
    const label = input.label || 'analysis';

    if (!depth && !nodes && !movetimeMs) {
      throw new UciError('analyze() requires at least one of depth, nodes or movetimeMs');
    }

    if (signal && signal.aborted) throw new UciAbortError();

    if (clearHash && this.hasOption('Clear Hash')) {
      await this.setOption('Clear Hash');
    }

    this.busy = true;
    const infoLines = [];
    let lastInfo = null;

    return new Promise((resolve, reject) => {
      const ctx = {
        resolve,
        reject,
        infoLines,
        lastInfo: null,
        label,
        timeoutMs,
        timedOut: false,
        aborted: false,
        timer: null,
        stopTimer: null,
        signal,
        abortHandler: null,
        finished: false
      };
      this._analysis = ctx;

      const finish = (fn, value) => {
        if (ctx.finished) return;
        ctx.finished = true;
        if (ctx.timer) clearTimeout(ctx.timer);
        if (ctx.stopTimer) clearTimeout(ctx.stopTimer);
        if (ctx.signal && ctx.abortHandler) ctx.signal.removeEventListener('abort', ctx.abortHandler);
        if (this._analysis === ctx) this._analysis = null;
        this.busy = false;
        fn(value);
      };
      ctx.finish = finish;

      if (ctx.signal) {
        ctx.abortHandler = () => {
          if (ctx.finished) return;
          ctx.aborted = true;
          this._write('stop');
          ctx.stopTimer = setTimeout(() => {
            finish(reject, new UciAbortError('Stockfish analysis was cancelled', { label }));
            this._kill();
          }, STOP_GRACE_MS);
        };
        signal.addEventListener('abort', ctx.abortHandler, { once: true });
      }

      ctx.timer = setTimeout(() => {
        if (ctx.finished) return;
        ctx.timedOut = true;
        this._write('stop');
        // Give Stockfish a short chance to return a bestmove, then kill it so
        // no search survives a timeout.
        ctx.stopTimer = setTimeout(() => {
          finish(reject, new UciTimeoutError(
            `Stockfish search "${label}" exceeded ${timeoutMs} ms`,
            { timeoutMs, label, stderr: this.stderr.trim().slice(-500) }
          ));
          this._kill();
        }, STOP_GRACE_MS);
      }, timeoutMs);

      const position = this._positionCommand(fen, moves);
      const go = ['go'];
      if (depth) go.push('depth', String(depth));
      if (nodes) go.push('nodes', String(nodes));
      if (movetimeMs) go.push('movetime', String(movetimeMs));
      if (searchmoves.length) go.push('searchmoves', ...searchmoves.slice(0, 256));
      try {
        this._write(position);
        this._write(go.join(' '));
      } catch (error) {
        finish(reject, new UciError(`Could not send search to Stockfish: ${error.message}`, { cause: error }));
      }
    });
  }

  _positionCommand(fen, moves) {
    const normalized = String(fen).trim();
    let command;
    if (normalized === START_FEN) command = 'position startpos';
    else command = `position fen ${normalized}`;
    if (moves.length) command += ` moves ${moves.join(' ')}`;
    return command;
  }

  _onStdout(chunk) {
    this._buffer += this._decoder.write(chunk);
    let newline;
    while ((newline = this._buffer.indexOf('\n')) >= 0) {
      let line = this._buffer.slice(0, newline);
      this._buffer = this._buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) this._onLine(line.trim());
    }
  }

  _onLine(line) {
    this.lines.push(line);
    if (this.lines.length > 5000) this.lines.splice(0, this.lines.length - 5000);
    if (this.onLine) this.onLine(line);

    const ctx = this._analysis;
    if (ctx) {
      if (line.startsWith('info ')) {
        const info = parseInfo(line);
        if (info) {
          ctx.infoLines.push(info);
          if (info.multipv === 1 && info.score) ctx.lastInfo = info;
        }
        return;
      }
      if (line.startsWith('bestmove')) {
        const parts = line.split(/\s+/);
        const bestmove = parts[1] && parts[1] !== '(none)' ? parts[1] : null;
        const ponder = parts[2] === 'ponder' && parts[3] ? parts[3] : null;
        const last = ctx.lastInfo;
        const result = {
          bestmove,
          ponder,
          score: last ? last.score : null,
          depth: last ? last.depth : null,
          seldepth: last ? last.seldepth : null,
          nodes: last ? last.nodes : null,
          nps: last ? last.nps : null,
          timeMs: last ? last.timeMs : null,
          hashfull: last ? last.hashfull : null,
          tbhits: last ? last.tbhits : null,
          pv: last ? last.pv.slice() : [],
          wdl: last ? last.wdl : null,
          timedOut: ctx.timedOut,
          aborted: ctx.aborted,
          infoCount: ctx.infoLines.length,
          rawInfo: ctx.infoLines.slice()
        };
        if (ctx.aborted) {
          ctx.finish(ctx.reject, new UciAbortError('Stockfish analysis was cancelled', { label: ctx.label }));
        } else if (ctx.timedOut) {
          // _stopTimer will normally reject; if bestmove won the race we still
          // report the timeout rather than pretending the search was complete.
          ctx.finish(ctx.reject, new UciTimeoutError(
            `Stockfish search "${ctx.label}" exceeded ${ctx.timeoutMs} ms`,
            { timeoutMs: ctx.timeoutMs, label: ctx.label, result }
          ));
        } else {
          ctx.finish(ctx.resolve, result);
        }
        return;
      }
      return;
    }

    if (line.startsWith('id name ')) this.id.name = line.slice(8).trim();
    else if (line.startsWith('id author ')) this.id.author = line.slice(10).trim();
    else if (line.startsWith('option ')) {
      const option = parseOptionLine(line);
      if (option) this.options.set(option.name.toLowerCase(), option);
    }

    if (this._waiter && this._waiter.predicate(line)) {
      const waiter = this._waiter;
      this._waiter = null;
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener('abort', waiter.abortHandler);
      waiter.resolve(line);
    }
  }

  _waitFor(predicate, timeoutMs, label, signal) {
    if (this._waiter) throw new UciError('Internal UCI waiter conflict');
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, label, timer: null, signal: signal || null, abortHandler: null };
      waiter.timer = setTimeout(() => {
        if (this._waiter === waiter) this._waiter = null;
        reject(new UciTimeoutError(`Stockfish did not answer ${label} within ${timeoutMs} ms`, { label, timeoutMs }));
      }, timeoutMs);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(waiter.timer);
          reject(new UciAbortError());
          return;
        }
        waiter.abortHandler = () => {
          if (this._waiter === waiter) this._waiter = null;
          clearTimeout(waiter.timer);
          reject(new UciAbortError('Stockfish handshake was cancelled', { label }));
        };
        signal.addEventListener('abort', waiter.abortHandler, { once: true });
      }
      this._waiter = waiter;
    });
  }

  _write(line) {
    const stdin = this.child && this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      throw new UciError('Stockfish stdin is not available');
    }
    stdin.write(`${line}\n`);
  }

  _assertRunning() {
    if (this.closed) throw new UciError('Stockfish adapter is closed');
    if (!this.child) throw new UciError('Stockfish adapter has not been started');
  }

  _fail(error) {
    if (this._analysis && !this._analysis.finished) {
      this._analysis.finish(this._analysis.reject, error);
    } else if (this._waiter) {
      const waiter = this._waiter;
      this._waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  _kill() {
    const child = this.child;
    if (!child) return;
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    // On Windows, kill() maps to TerminateProcess and is sufficient. Keep the
    // reference so exit cleanup can still run.
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    if (this._analysis && !this._analysis.finished) {
      this._analysis.finish(this._analysis.reject, new UciAbortError('Stockfish adapter closed during analysis'));
    }
    if (this._waiter) {
      const waiter = this._waiter;
      this._waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new UciAbortError('Stockfish adapter closed'));
    }
    try { this._write('quit'); } catch { /* process may already be gone */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        this._kill();
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }
}

module.exports = {
  Stockfish,
  UciError,
  UciTimeoutError,
  UciAbortError,
  isAbortError,
  parseInfo,
  START_FEN
};
