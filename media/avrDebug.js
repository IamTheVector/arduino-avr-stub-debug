// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const gdbCmdArea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("gdbCmdArea"));
  const skipCoreChk = /** @type {HTMLInputElement | null} */ (document.getElementById("chkSkipArduinoCoreSources"));
  const serialSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("serialPortSelect"));
  const btnSerialRefresh = document.getElementById("btn-serial-refresh");

  /** Last sent multiline buffers (newest at end) */
  /** @type {string[]} */
  let gdbHistory = [];
  let gdbHistIndex = 0;
  let gdbHistDraft = "";

  const sections = {
    variables: document.getElementById("sec-variables-body"),
    watch: document.getElementById("sec-watch-body"),
    stack: document.getElementById("sec-stack-body"),
    breakpoints: document.getElementById("sec-bp-body"),
    peripherals: document.getElementById("sec-periph-body"),
    registers: document.getElementById("sec-reg-body"),
    memory: document.getElementById("sec-mem-body"),
    disassembly: document.getElementById("sec-asm-body")
  };

  /** @type {string[]} */
  let watchExprs = [];

  function bindBtn(id, msg) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", () => vscode.postMessage(msg));
    }
  }

  bindBtn("btn-start", { type: "start" });
  bindBtn("btn-continue", { type: "continue" });
  bindBtn("btn-pause", { type: "pause" });
  bindBtn("btn-next", { type: "next" });
  bindBtn("btn-step", { type: "step" });
  bindBtn("btn-finish", { type: "finish" });
  bindBtn("btn-restart", { type: "restart" });
  bindBtn("btn-stop", { type: "stop" });
  bindBtn("btn-refresh", { type: "refresh" });

  bindBtn("btn-help", { type: "gdbHelp", topic: "" });
  bindBtn("btn-help-break", { type: "gdbHelp", topic: "break" });
  bindBtn("btn-help-define", { type: "gdbHelp", topic: "define" });
  bindBtn("btn-open-gdb-term", { type: "openGdbTerminal" });

  if (skipCoreChk) {
    skipCoreChk.addEventListener("change", () => {
      vscode.postMessage({
        type: "setSkipArduinoCoreSources",
        value: !!skipCoreChk.checked
      });
    });
  }

  if (btnSerialRefresh) {
    btnSerialRefresh.addEventListener("click", () => {
      vscode.postMessage({ type: "serialPortsRefresh" });
    });
  }

  if (serialSelect) {
    serialSelect.addEventListener("change", () => {
      vscode.postMessage({ type: "serialPortSet", value: serialSelect.value });
    });
  }

  const btnGdbSend = document.getElementById("btn-gdb-send");
  const btnGdbClear = document.getElementById("btn-gdb-clear");

  function buildContextMenu(target, opts) {
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.display = "none";
    document.body.appendChild(menu);
    const hide = () => {
      menu.style.display = "none";
      menu.innerHTML = "";
    };
    const copySel = async () => {
      const selected = opts.getSelectionText();
      if (!selected) {
        return;
      }
      try {
        await navigator.clipboard.writeText(selected);
      } catch {
        document.execCommand("copy");
      }
    };
    const cutSel = async () => {
      const ta = opts.getEditable?.();
      if (!ta) {
        return;
      }
      try {
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        if (e <= s) {
          return;
        }
        await navigator.clipboard.writeText(ta.value.slice(s, e));
        ta.setRangeText("", s, e, "end");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        document.execCommand("cut");
      }
    };
    const pasteSel = async () => {
      const ta = opts.getEditable?.();
      if (!ta) {
        return;
      }
      try {
        const t = await navigator.clipboard.readText();
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        ta.setRangeText(t, s, e, "end");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        document.execCommand("paste");
      }
    };
    const selectAll = () => {
      const ta = opts.getEditable?.();
      if (ta) {
        ta.focus();
        ta.select();
      } else {
        const r = document.createRange();
        r.selectNodeContents(target);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
    };
    const mk = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", async () => {
        await fn();
        hide();
      });
      menu.appendChild(b);
    };
    target.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu.innerHTML = "";
      mk("Copy", copySel);
      if (opts.getEditable) {
        mk("Cut", cutSel);
        mk("Paste", pasteSel);
      }
      mk("Select all", selectAll);
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      menu.style.display = "flex";
    });
    document.addEventListener("click", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
  }

  // Global context menu (right-click) so Copy/Paste/Cut work even on "empty" areas.
  // VS Code webviews often provide no default menu, so we render a small one ourselves.
  (function setupGlobalContextMenu() {
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.display = "none";
    document.body.appendChild(menu);

    const hide = () => {
      menu.style.display = "none";
      menu.innerHTML = "";
    };

    const getActiveEditable = () => {
      const el = document.activeElement;
      if (!el) return null;
      if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) {
        return null;
      }
      return el;
    };

    const mk = (label, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", async () => {
        await onClick();
        hide();
      });
      menu.appendChild(b);
    };

    const copySelection = async () => {
      const sel = window.getSelection()?.toString() ?? "";
      if (!sel) return;
      try {
        await navigator.clipboard.writeText(sel);
      } catch {
        document.execCommand("copy");
      }
    };

    const cutSelection = async () => {
      const ta = getActiveEditable();
      if (!ta) return;
      const s = ta.selectionStart ?? 0;
      const e = ta.selectionEnd ?? 0;
      if (e <= s) return;
      try {
        await navigator.clipboard.writeText(ta.value.slice(s, e));
      } catch {
        // ignore
      }
      ta.setRangeText("", s, e, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    };

    const pasteIntoActive = async () => {
      const ta = getActiveEditable();
      try {
        const text = await navigator.clipboard.readText();
        if (ta) {
          const s = ta.selectionStart ?? 0;
          const e = ta.selectionEnd ?? 0;
          ta.setRangeText(text, s, e, "end");
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
      } catch {
        // fallback
      }
      document.execCommand("paste");
    };

    const selectAllActive = async () => {
      const ta = getActiveEditable();
      if (ta && typeof ta.select === "function") {
        ta.focus();
        ta.select();
      }
    };

    document.addEventListener("contextmenu", (e) => {
      // Let the textarea-specific menu handle the command box itself.
      if (gdbCmdArea && gdbCmdArea.contains(e.target)) {
        return;
      }
      e.preventDefault();
      menu.innerHTML = "";
      mk("Copy", copySelection);
      const hasActive = !!getActiveEditable();
      if (hasActive) {
        mk("Cut", cutSelection);
      }
      mk("Paste", pasteIntoActive);
      mk("Select all", selectAllActive);
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      menu.style.display = "flex";
    });

    document.addEventListener("click", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
  })();

  function normalizeBuffer() {
    return gdbCmdArea ? gdbCmdArea.value.replace(/\r\n/g, "\n") : "";
  }

  function bufferToLines(text) {
    return text
      .split(/\n/)
      .map((l) => l.replace(/\r$/, "").replace(/\s+$/, ""))
      .filter((l) => l.length > 0);
  }

  const GDB_CMD_MAX_H = Math.floor(window.innerHeight * 0.28);

  function autoResizeGdbCmd() {
    if (!gdbCmdArea) {
      return;
    }
    gdbCmdArea.style.height = "0px";
    const sh = gdbCmdArea.scrollHeight;
    const capped = Math.min(sh, GDB_CMD_MAX_H);
    gdbCmdArea.style.height = `${Math.max(capped, 56)}px`;
    gdbCmdArea.style.overflowY = sh > GDB_CMD_MAX_H ? "auto" : "hidden";
  }

  function sendGdbBuffer() {
    if (!gdbCmdArea) {
      return;
    }
    const raw = normalizeBuffer();
    const lines = bufferToLines(raw);
    if (lines.length === 0) {
      return;
    }
    if (gdbHistory.length === 0 || gdbHistory[gdbHistory.length - 1] !== raw) {
      gdbHistory.push(raw);
      if (gdbHistory.length > 100) {
        gdbHistory.shift();
      }
    }
    vscode.postMessage({ type: "consoleLines", lines });
    gdbCmdArea.value = "";
    gdbHistIndex = gdbHistory.length;
    gdbHistDraft = "";
    autoResizeGdbCmd();
  }

  if (btnGdbSend) {
    btnGdbSend.addEventListener("click", () => sendGdbBuffer());
  }
  if (btnGdbClear) {
    btnGdbClear.addEventListener("click", () => {
      if (gdbCmdArea) {
        gdbCmdArea.value = "";
        autoResizeGdbCmd();
      }
    });
  }

  function historyUp() {
    if (!gdbCmdArea || gdbHistory.length === 0) {
      return;
    }
    if (gdbHistIndex === gdbHistory.length) {
      gdbHistDraft = normalizeBuffer();
    }
    if (gdbHistIndex > 0) {
      gdbHistIndex -= 1;
      gdbCmdArea.value = gdbHistory[gdbHistIndex];
      autoResizeGdbCmd();
    }
  }

  function historyDown() {
    if (!gdbCmdArea || gdbHistory.length === 0) {
      return;
    }
    if (gdbHistIndex < gdbHistory.length - 1) {
      gdbHistIndex += 1;
      gdbCmdArea.value = gdbHistory[gdbHistIndex];
      autoResizeGdbCmd();
    } else {
      gdbHistIndex = gdbHistory.length;
      gdbCmdArea.value = gdbHistDraft;
      autoResizeGdbCmd();
    }
  }

  if (gdbCmdArea) {
    buildContextMenu(gdbCmdArea, {
      getSelectionText: () =>
        gdbCmdArea.selectionStart === gdbCmdArea.selectionEnd
          ? ""
          : gdbCmdArea.value.slice(gdbCmdArea.selectionStart, gdbCmdArea.selectionEnd),
      getEditable: () => gdbCmdArea
    });
    gdbCmdArea.addEventListener("input", () => autoResizeGdbCmd());
    window.addEventListener("resize", () => autoResizeGdbCmd());
    autoResizeGdbCmd();
    gdbCmdArea.addEventListener("keydown", (e) => {
      if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        const hasSelection = gdbCmdArea.selectionStart !== gdbCmdArea.selectionEnd;
        if (hasSelection) {
          return;
        }
        e.preventDefault();
        vscode.postMessage({ type: "consoleInterrupt" });
        return;
      }
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        sendGdbBuffer();
        return;
      }
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        historyUp();
        return;
      }
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        historyDown();
        return;
      }
    });
  }

  const watchAddBtn = document.getElementById("btn-watch-add");
  const watchInput = document.getElementById("watchInput");
  if (watchAddBtn && watchInput) {
    watchAddBtn.addEventListener("click", () => {
      const expr = watchInput.value.trim();
      if (expr) {
        vscode.postMessage({ type: "watchAdd", expr });
        watchInput.value = "";
      }
    });
  }

  const varAddBtn = document.getElementById("btn-var-add");
  const varInput = document.getElementById("varInput");
  const varSelBtn = document.getElementById("btn-var-sel");
  if (varAddBtn && varInput) {
    varAddBtn.addEventListener("click", () => {
      const name = varInput.value.trim();
      if (name) {
        vscode.postMessage({ type: "varAdd", name });
        varInput.value = "";
      }
    });
  }
  if (varSelBtn) {
    varSelBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "varAddFromSelection" });
    });
  }

  document.querySelectorAll(".collapsible > .sec-h").forEach((h) => {
    h.addEventListener("click", () => {
      h.parentElement.classList.toggle("open");
    });
  });

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function bindVariableValueEditors(container) {
    if (!container) {
      return;
    }
    container.querySelectorAll(".wv").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (el.querySelector("input")) {
          return;
        }
        const i = Number(el.getAttribute("data-vi"));
        if (Number.isNaN(i)) {
          return;
        }
        const current = el.textContent ?? "";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "wv-edit";
        input.value = current;
        el.textContent = "";
        el.appendChild(input);
        input.focus();
        input.select();
        let finished = false;
        function commit() {
          if (finished) {
            return;
          }
          finished = true;
          const nv = input.value.trim();
          input.remove();
          el.textContent = current;
          if (nv.length > 0 && nv !== current) {
            vscode.postMessage({ type: "varSetValue", index: i, value: nv });
          }
        }
        function cancel() {
          if (finished) {
            return;
          }
          finished = true;
          input.remove();
          el.textContent = current;
        }
        input.addEventListener("blur", () => commit());
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            commit();
          }
          if (ev.key === "Escape") {
            ev.preventDefault();
            cancel();
          }
        });
      });
    });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "full") {
      const hintEl = document.getElementById("panelHint");
      if (hintEl && msg.panelHint !== undefined) {
        hintEl.textContent = msg.panelHint || "";
      }
      if (serialSelect && msg.serialPorts && Array.isArray(msg.serialPorts)) {
        const cur = serialSelect.value;
        const options = /** @type {{ id: string; name: string }[]} */ (msg.serialPorts);
        serialSelect.innerHTML = "";
        for (const p of options) {
          const opt = document.createElement("option");
          opt.value = p.id;
          opt.textContent = p.name ? `${p.id} (${p.name})` : p.id;
          serialSelect.appendChild(opt);
        }
        const selected = typeof msg.selectedSerialPort === "string" ? msg.selectedSerialPort : cur;
        if (selected && options.some((x) => x.id === selected)) {
          serialSelect.value = selected;
        }
      }
      if (skipCoreChk && typeof msg.skipArduinoCoreSources === "boolean") {
        skipCoreChk.checked = msg.skipArduinoCoreSources;
      }
      const idleHint =
        "Start a session. Type GDB in AVR-GDB CONSOLE (Ctrl+Enter to run). Views update when the target stops.";
      if (msg.variables && sections.variables) {
        sections.variables.innerHTML = renderVariableList(msg.variables);
        sections.variables.querySelectorAll(".vrm").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const i = Number(btn.getAttribute("data-vi"));
            vscode.postMessage({ type: "varRemove", index: i });
          });
        });
        bindVariableValueEditors(sections.variables);
      }
      if (msg.debuggerMode) {
        if (msg.stack && sections.stack) {
          sections.stack.innerHTML = tableFromRows(
            ["#", "Function", "File", "Line"],
            msg.stack.map((f) => [
              String(f.level),
              f.func,
              f.file || f.fullname || "",
              f.line || ""
            ])
          );
        }
        if (msg.registers !== undefined && sections.registers) {
          if (!msg.registers || msg.registers.length === 0) {
            sections.registers.innerHTML = `<p class="hint">${esc(
              "No register rows (target may be running). Stop the target first."
            )}</p>`;
          } else {
            sections.registers.innerHTML = tableFromRows(
              ["Register", "Value"],
              msg.registers.map((r) => [r.name, r.value])
            );
          }
        }
        if (msg.memory !== undefined && sections.memory) {
          sections.memory.innerHTML = msg.memory
            ? `<pre class="hex">${esc(msg.memory)}</pre>`
            : `<p class="hint">${esc("(empty)")}</p>`;
        }
        if (msg.disassembly !== undefined && sections.disassembly) {
          sections.disassembly.innerHTML = msg.disassembly
            ? `<pre class="asm">${esc(msg.disassembly)}</pre>`
            : `<p class="hint">${esc("(empty)")}</p>`;
        }
        if (msg.peripherals && sections.peripherals) {
          sections.peripherals.innerHTML = tableFromRows(
            ["Addr", "Name", "Value"],
            msg.peripherals.map((p) => [p.addr, p.name, p.value])
          );
        }
      } else if (msg.terminalMode) {
        if (sections.stack) {
          sections.stack.innerHTML = `<p class="hint">${esc(idleHint)}</p>`;
        }
        if (sections.registers) {
          sections.registers.innerHTML = `<p class="hint">${esc(idleHint)}</p>`;
        }
        if (sections.memory) {
          sections.memory.innerHTML = `<p class="hint">${esc(idleHint)}</p>`;
        }
        if (sections.disassembly) {
          sections.disassembly.innerHTML = `<p class="hint">${esc(idleHint)}</p>`;
        }
        if (sections.peripherals) {
          sections.peripherals.innerHTML = `<p class="hint">${esc(idleHint)}</p>`;
        }
      }
      if (msg.breakpoints && sections.breakpoints) {
        sections.breakpoints.innerHTML = tableFromRows(
          ["File", "Line", "Enabled"],
          msg.breakpoints.map((b) => [b.file, String(b.line), b.enabled ? "yes" : "no"])
        );
      }
      if (msg.watch) {
        watchExprs = msg.watch;
        if (sections.watch) {
          sections.watch.innerHTML = msg.watch
            .map(
              (w, i) =>
                `<div class="watch-row"><span class="we">${esc(w.expr)}</span><span class="wv">${esc(w.value)}</span><button data-wi="${i}" class="wrm">×</button></div>`
            )
            .join("");
          sections.watch.querySelectorAll(".wrm").forEach((btn) => {
            btn.addEventListener("click", () => {
              const i = Number(btn.getAttribute("data-wi"));
              vscode.postMessage({ type: "watchRemove", index: i });
            });
          });
        }
      }
      if (msg.status) {
        const st = document.getElementById("status");
        if (st) {
          st.textContent = msg.status;
        }
      }
    }
  });

  function renderVariableList(vars) {
    if (!vars || vars.length === 0) {
      return `<p class="hint">${esc("Use Add / Sel above. Values update when the target stops.")}</p>`;
    }
    return vars
      .map(
        (v, i) =>
          `<div class="watch-row"><span class="we">${esc(v.name)}</span><span class="wv val-editable" data-vi="${i}" title="Click to edit (set variable)">${esc(String(v.value))}</span><button type="button" data-vi="${i}" class="wrm vrm">×</button></div>`
      )
      .join("");
  }

  function tableFromRows(headers, rows) {
    let h = "<table><thead><tr>";
    for (const x of headers) {
      h += `<th>${esc(x)}</th>`;
    }
    h += "</tr></thead><tbody>";
    for (const row of rows) {
      h += "<tr>";
      for (const cell of row) {
        h += `<td>${esc(String(cell))}</td>`;
      }
      h += "</tr>";
    }
    return h + "</tbody></table>";
  }

  vscode.postMessage({ type: "ready" });
})();
