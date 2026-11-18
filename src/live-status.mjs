// A one-line live status for the phases where an agent process is alive.
// @clack's spinner puts stdin in raw mode and exits the process with code 0
// on Ctrl-C, which would leave the agent running and its temp dir and
// transcript behind. This one looks the same (gray bar, magenta frame) but
// hands Ctrl-C to `onCancel`, so the caller can abort the run and clean up.
import { styleText } from "node:util";

const FRAMES = process.platform === "win32" ? ["•", "o", "O", "0"] : ["◒", "◐", "◓", "◑"];
const DELAY_MS = 80;
const CTRL_C = "\x03";

/**
 * @param {{ onCancel: () => void, input?: object, output?: object, style?: Function, frames?: string[], delay?: number }} o
 * `input` is stdin-like (isTTY, setRawMode, resume, pause, on/off "data"); `output` has write().
 */
export function liveStatus({ onCancel, input = process.stdin, output = process.stdout, style = styleText, frames = FRAMES, delay = DELAY_MS }) {
  let message = "";
  let frame = 0;
  let timer = null;
  let active = false;
  let wasRaw = false;
  let resumed = false;

  const clear = () => output.write("\r\x1b[2K");
  const draw = () => {
    clear();
    output.write(`${style("magenta", frames[frame % frames.length])}  ${message}`);
  };
  const onData = (chunk) => {
    if (String(chunk).includes(CTRL_C)) onCancel();
  };
  const release = () => {
    if (!active) return false;
    active = false;
    clearInterval(timer);
    timer = null;
    input.off?.("data", onData);
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(wasRaw);
    if (resumed) input.pause?.();
    output.write("\x1b[?25h");
    clear();
    return true;
  };

  return {
    start(msg = "") {
      if (active) return;
      active = true;
      message = msg;
      output.write(`${style("gray", "│")}\n\x1b[?25l`);
      if (input.isTTY && typeof input.setRawMode === "function") {
        wasRaw = Boolean(input.isRaw);
        input.setRawMode(true);
      }
      resumed = Boolean(input.isPaused?.());
      input.resume?.();
      input.on("data", onData);
      draw();
      timer = setInterval(() => {
        frame++;
        draw();
      }, delay);
      timer.unref?.();
    },
    message(msg = "") {
      message = msg;
      if (active) draw();
    },
    stop(msg = "") {
      if (release()) output.write(`${style("green", "◇")}  ${msg}\n`);
    },
    error(msg = "") {
      if (release()) output.write(`${style("red", "■")}  ${msg}\n`);
    },
  };
}
