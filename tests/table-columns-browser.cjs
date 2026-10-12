/* Build the viewer and run presentation-smoke.py first. Start the local server;
 * set ISAACPROF_TEST_CAPTURE to its channel-6144 owned host recording.
 * ISAACPROF_TEST_URL can override the default http://127.0.0.1:8765/. */
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "build/wait-browser-qa");
const frameFile = process.env.ISAACPROF_TEST_CAPTURE;
fs.mkdirSync(out, { recursive: true });
const chrome = spawn(
  process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=9330",
    `--user-data-dir=${path.join(out, "profile-" + process.pid)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws,
  session,
  sequence = 0;
const pending = new Map(),
  events = [];
async function until(fn) {
  for (let i = 0; i < 600; i++) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error(
    "UI test timeout: " +
      (await evaluate(
        'JSON.stringify({status:document.querySelector(".status-bar")?.textContent,filmstrip:!!document.querySelector("#filmstrip"),filename:document.querySelector("#filename")?.textContent,panel:document.querySelector("#analysis-content")?.textContent})',
      )),
  );
}
function send(method, params = {}, sid) {
  return new Promise((resolve, reject) => {
    const id = ++sequence,
      timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Error(
            `CDP timeout: ${method} ${(params.expression || "").slice(0, 160)}`,
          ),
        );
      }, 20000);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sid ? { sessionId: sid } : {}),
      }),
    );
  });
}
async function evaluate(expression) {
  const r = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    session,
  );
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function mouse(type, p) {
  await send(
    "Input.dispatchMouseEvent",
    {
      type,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      ...p,
    },
    session,
  );
}
async function click(selector) {
  const p = await evaluate(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await mouse("mousePressed", p);
  await mouse("mouseReleased", p);
}
async function files(selector, paths) {
  const doc = await send("DOM.getDocument", {}, session),
    input = await send(
      "DOM.querySelector",
      { nodeId: doc.root.nodeId, selector },
      session,
    );
  await send(
    "DOM.setFileInputFiles",
    { nodeId: input.nodeId, files: paths },
    session,
  );
}

(async () => {
  try {
    const version = await until(async () => {
      try {
        return await (await fetch("http://127.0.0.1:9330/json/version")).json();
      } catch {
        return false;
      }
    });
    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
    ws.addEventListener("message", (message) => {
      const data = JSON.parse(message.data);
      if (data.id) {
        const p = pending.get(data.id);
        if (p) {
          pending.delete(data.id);
          clearTimeout(p.timer);
          data.error
            ? p.reject(Error(data.error.message))
            : p.resolve(data.result);
        }
      } else events.push(data);
    });
    const target = await send("Target.createTarget", { url: "about:blank" });
    session = (
      await send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      })
    ).sessionId;
    await send("Runtime.enable", {}, session);
    await send("Page.enable", {}, session);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false },
      session,
    );
    await send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: 'localStorage.setItem("isaacprof.drawer-height","650")' },
      session,
    );
    await send(
      "Page.navigate",
      { url: process.env.ISAACPROF_TEST_URL || "http://127.0.0.1:8765/" },
      session,
    );
    await until(() => evaluate('!!document.querySelector("#file")'));
    await files("#file", [frameFile]);
    await until(() =>
      evaluate(
        'document.querySelector("#filename").textContent.includes(' +
          JSON.stringify(path.basename(frameFile)) +
          ")",
      ),
    );
    await click("#tab-frames");
    await until(() =>
      evaluate('!!document.querySelector("#presentation-frames")'),
    );
    await click("#presentation-frames");
    await until(() =>
      evaluate('!!document.querySelector("#native-waits-table")'),
    );
    assert(
      await evaluate(
        'document.querySelector("#presentation-panel").textContent.includes("isaacprof-test-host.exe+0x")',
      ),
    );
    if (process.env.ISAACPROF_WAIT_ONLY) {
      assert(
        await evaluate(
          'document.querySelector("#presentation-panel").textContent.includes("Native waits below remain available independently")',
        ),
      );
    } else {
      assert(
        await evaluate(
          'document.querySelector("#presentation-panel").textContent.includes("Wait hooks 6/6")',
        ),
      );
    }
    assert(
      await evaluate(
        '!document.querySelector("#native-waits-table").closest("details").open',
      ),
    );
    await evaluate(
      'document.querySelector("#native-waits-table").closest("details").open=true',
    );
    await evaluate(
      'document.querySelector("#native-waits-table").scrollIntoView({block:"center"})',
    );
    await click("#native-waits-table th:nth-child(1) button");
    await until(() =>
      evaluate(
        'document.querySelector("#native-waits-table th").getAttribute("aria-sort")==="ascending"',
      ),
    );
    const starts = await evaluate(
      '[...document.querySelectorAll("#native-waits-table tbody tr")].map(r=>parseFloat(r.cells[0].textContent.replaceAll(",", "")))',
    );
    assert(starts.every((v, i) => i === 0 || v >= starts[i - 1]));
    const columnWidth = () =>
      evaluate(
        'document.querySelector("#native-waits-table th").getBoundingClientRect().width',
      );
    const before = await columnWidth();
    const grip = await evaluate(
      '(()=>{const r=document.querySelector("#native-waits-table .column-resizer").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    );
    await mouse("mousePressed", grip);
    await mouse("mouseMoved", { x: grip.x + 80, y: grip.y });
    await mouse("mouseReleased", { x: grip.x + 80, y: grip.y });
    assert(
      Math.abs((await columnWidth()) - before - 80) < 2,
      "Drag did not resize by 80 px",
    );
    assert.equal(
      await evaluate(
        'document.querySelector("#native-waits-table th").getAttribute("aria-sort")',
      ),
      "ascending",
      "Resize changed sorting",
    );
    const persisted = await columnWidth();
    await click("#presentation-panel .analysis-toolbar button");
    await click("#presentation-frames");
    await until(() =>
      evaluate('!!document.querySelector("#native-waits-table")'),
    );
    await evaluate(
      'document.querySelector("#native-waits-table").closest("details").open=true',
    );
    assert(
      Math.abs((await columnWidth()) - persisted) < 2,
      "Column width lost after navigation",
    );
    await evaluate(
      'document.querySelector("#native-waits-table .column-resizer").focus()',
    );
    await send(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: "ArrowRight",
        code: "ArrowRight",
        windowsVirtualKeyCode: 39,
      },
      session,
    );
    await send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: "ArrowRight",
        code: "ArrowRight",
        windowsVirtualKeyCode: 39,
      },
      session,
    );
    assert(
      Math.abs((await columnWidth()) - persisted - 10) < 2,
      "Keyboard did not resize by 10 px",
    );
    const afterKeyboard = await columnWidth();
    await send("Page.reload", {}, session);
    await until(() => evaluate('!!document.querySelector("#file")'));
    await files("#file", [frameFile]);
    await until(() =>
      evaluate(
        'document.querySelector("#filename").textContent.includes(' +
          JSON.stringify(path.basename(frameFile)) +
          ")",
      ),
    );
    await click("#tab-frames");
    await until(() =>
      evaluate('!!document.querySelector("#presentation-frames")'),
    );
    await click("#presentation-frames");
    await until(() =>
      evaluate('!!document.querySelector("#native-waits-table")'),
    );
    await evaluate(
      'document.querySelector("#native-waits-table").closest("details").open=true',
    );
    assert(
      Math.abs((await columnWidth()) - afterKeyboard) < 2,
      "Column width lost after reload",
    );
    await evaluate(
      'document.querySelector("#presentation-table").scrollIntoView({block:"center"})',
    );
    const getWidths = () =>
      evaluate(
        '[...document.querySelectorAll("#presentation-table th")].map(c=>c.getBoundingClientRect().width)',
      );
    const presentationBefore = await getWidths();
    const presentationGrip = await evaluate(
      '(()=>{const r=document.querySelector("#presentation-table th:last-child .column-resizer").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    );
    await mouse("mousePressed", presentationGrip);
    await mouse("mouseMoved", {
      x: presentationGrip.x + 60,
      y: presentationGrip.y,
    });
    await mouse("mouseReleased", {
      x: presentationGrip.x + 60,
      y: presentationGrip.y,
    });
    const presentationAfter = await getWidths();
    assert(
      Math.abs(presentationAfter.at(-1) - presentationBefore.at(-1) - 60) < 2,
      "Presentation last column did not resize",
    );
    assert(
      presentationAfter
        .slice(0, -1)
        .every((v, i) => Math.abs(v - presentationBefore[i]) < 2),
      "Resize changed adjacent column widths",
    );
    await evaluate(
      'document.querySelector("#native-waits-table").scrollIntoView({block:"center"})',
    );
    assert(
      Math.abs((await columnWidth()) - afterKeyboard) < 2,
      "Resizing presentation affected wait table",
    );
    await evaluate(
      'document.querySelector("#native-waits-table .column-resizer").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))',
    );
    assert.equal(
      await evaluate(
        'localStorage.getItem("isaacprof.table-columns:start|kind|duration|requestedMs|callSite")',
      ),
      null,
      "Double-click did not clear remembered widths",
    );
    const shot = await send(
      "Page.captureScreenshot",
      { format: "png" },
      session,
    );
    fs.writeFileSync(
      path.join(out, "native-waits.png"),
      Buffer.from(shot.data, "base64"),
    );
    await click("#native-waits-table tbody .row-button");
    await until(() =>
      evaluate('!!document.querySelector("#native-waits-table tbody tr")'),
    );
    assert.equal(
      events.filter((e) => e.method === "Runtime.exceptionThrown").length,
      0,
      JSON.stringify(events),
    );
    console.log(
      "PASS: wait/render state UI, folded call sites, shared sorting, pointer/keyboard resizing, persisted widths and exact wait selection; no runtime exceptions",
    );
  } finally {
    if (ws) {
      try {
        await send("Browser.close");
      } catch {}
      ws.close();
    }
    chrome.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
