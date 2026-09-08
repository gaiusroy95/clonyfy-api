import { createWriteStream, mkdirSync } from 'fs';
import { join, dirname } from 'path';

type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
type LogSink = (line: string, level: Level) => void;

let logStream: ReturnType<typeof createWriteStream> | null = null;
let logPath = '';
let verboseConsole = false;
let logSink: LogSink | null = null;

export function setLogSink(sink: LogSink | null) {
  logSink = sink;
}

export function initLogger(outDir: string, verbose = false) {
  mkdirSync(outDir, { recursive: true });
  verboseConsole = verbose || process.env['DEBUG'] === '1';
  logPath = join(outDir, 'cloner.log');
  logStream = createWriteStream(logPath, { flags: 'w' });
  const mode = verboseConsole ? 'verbose' : 'normal (DEBUG lines → log file only)';
  writeToFile('INFO', `Log started — output: ${outDir} — console mode: ${mode}`);
}

function writeToFile(level: Level, msg: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (logStream) logStream.write(line + '\n');
}

export const logger = {
  info: (msg: string) => {
    writeToFile('INFO', msg);
    console.log(msg);
    logSink?.(msg, 'INFO');
  },
  warn: (msg: string) => {
    writeToFile('WARN', msg);
    const line = `[WARN] ${msg}`;
    console.log(line);
    logSink?.(line, 'WARN');
  },
  error: (msg: string, err?: unknown) => {
    const detail = err instanceof Error ? `\n  ${err.stack ?? err.message}` : '';
    writeToFile('ERROR', msg + detail);
    const line = `[ERROR] ${msg}${detail}`;
    console.error(line);
    logSink?.(line, 'ERROR');
  },
  debug: (msg: string) => {
    writeToFile('DEBUG', msg);
    if (verboseConsole) {
      const line = `[DEBUG] ${msg}`;
      console.log(line);
      logSink?.(line, 'DEBUG');
    }
  },
  getLogPath: () => logPath,
  close: () => {
    if (logStream) { logStream.end(); logStream = null; }
  },
};
