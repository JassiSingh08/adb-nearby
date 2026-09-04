import readline from "node:readline";

const isTTY = () => process.stdin.isTTY && process.stdout.isTTY;

const C = {
  dim: (s) => `[2m${s}[0m`,
  bold: (s) => `[1m${s}[0m`,
  cyan: (s) => `[36m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  red: (s) => `[31m${s}[0m`,
  yellow: (s) => `[33m${s}[0m`,
};

export const c = C;
export const info = (msg) => console.log(`${C.cyan("==>")} ${msg}`);
export const ok = (msg) => console.log(`${C.green("ok:")} ${msg}`);
export const warn = (msg) => console.error(`${C.yellow("warn:")} ${msg}`);
export const fail = (msg) => console.error(`${C.red("error:")} ${msg}`);

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Returns a stop() that clears the line. Silent when stdout is not a TTY, so
 * piped and CI output stays clean rather than filling with frames.
 * `label` receives elapsed seconds so callers can show a countdown.
 */
export function spinner(label) {
  const text = typeof label === "function" ? label : () => label;

  if (!process.stdout.isTTY) {
    console.log(text(0));
    return () => {};
  }

  const started = Date.now();
  let frame = 0;
  let live = true;

  const draw = () => {
    if (!live) return;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    // Erase the whole line, not just from the cursor: the previous frame can be
    // longer than this one, and the tail would otherwise survive.
    process.stdout.write(`\r[2K${C.cyan(FRAMES[frame])} ${text(elapsed)}`);
    frame = (frame + 1) % FRAMES.length;
  };

  draw();
  const timer = setInterval(draw, 80);

  return () => {
    if (!live) return;
    live = false;
    clearInterval(timer);
    process.stdout.write("\r[2K");
  };
}

/**
 * Arrow-key picker. Falls back to a numbered prompt when stdin is not a TTY,
 * so the tool still works under CI and piped shells.
 */
export async function select(title, items, render) {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  if (!isTTY()) return selectNumbered(title, items, render);

  return new Promise((resolve) => {
    let index = 0;
    const height = items.length + 2;

    const draw = (first = false) => {
      if (!first) process.stdout.write(`[${height}A`);
      process.stdout.write(`${C.bold(title)}[K\n`);
      items.forEach((item, i) => {
        const pointer = i === index ? C.cyan("❯") : " ";
        const label = i === index ? C.cyan(render(item)) : render(item);
        process.stdout.write(`${pointer} ${label}[K\n`);
      });
      process.stdout.write(
        `${C.dim("↑/↓ move · enter select · q quit")}[K\n`,
      );
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    draw(true);

    const done = (value) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("keypress", onKey);
      resolve(value);
    };

    const onKey = (_str, key) => {
      if (key.name === "up") index = (index - 1 + items.length) % items.length;
      else if (key.name === "down") index = (index + 1) % items.length;
      else if (key.name === "return") return done(items[index]);
      else if (key.name === "q" || (key.ctrl && key.name === "c"))
        return done(null);
      else return;
      draw();
    };

    process.stdin.on("keypress", onKey);
  });
}

async function selectNumbered(title, items, render) {
  console.log(C.bold(title));
  items.forEach((item, i) => console.log(`  ${i + 1}. ${render(item)}`));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) =>
    rl.question("Pick a number: ", resolve),
  );
  rl.close();

  const picked = items[Number(answer) - 1];
  return picked ?? null;
}
