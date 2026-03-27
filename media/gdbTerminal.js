// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const termOut = document.getElementById("termOut");
  const gdbTermCmd = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("gdbTermCmd"));

  /** @type {string[]} */
  let gdbHistory = [];
  let gdbHistIndex = 0;
  let gdbHistDraft = "";

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

  function bindBtn(id, msg) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", () => vscode.postMessage(msg));
    }
  }

  bindBtn("btn-help", { type: "gdbHelp", topic: "" });
  bindBtn("btn-help-break", { type: "gdbHelp", topic: "break" });
  bindBtn("btn-help-define", { type: "gdbHelp", topic: "define" });

  document.getElementById("btn-term-clear")?.addEventListener("click", () => {
    if (termOut) {
      termOut.textContent = "";
    }
  });

  function normalizeBuffer() {
    return gdbTermCmd ? gdbTermCmd.value.replace(/\r\n/g, "\n") : "";
  }

  function bufferToLines(text) {
    return text
      .split(/\n/)
      .map((l) => l.replace(/\r$/, "").replace(/\s+$/, ""))
      .filter((l) => l.length > 0);
  }

  function autoResizeCmd() {
    if (!gdbTermCmd) {
      return;
    }
    gdbTermCmd.style.height = "0px";
    const sh = gdbTermCmd.scrollHeight;
    const max = Math.floor(window.innerHeight * 0.32);
    gdbTermCmd.style.height = `${Math.min(Math.max(sh, 48), max)}px`;
    gdbTermCmd.style.overflowY = sh > max ? "auto" : "hidden";
  }

  function sendBuffer() {
    if (!gdbTermCmd) {
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
    gdbTermCmd.value = "";
    gdbHistIndex = gdbHistory.length;
    gdbHistDraft = "";
    autoResizeCmd();
  }

  document.getElementById("btn-gdb-send")?.addEventListener("click", () => sendBuffer());

  if (gdbTermCmd) {
    buildContextMenu(gdbTermCmd, {
      getSelectionText: () =>
        gdbTermCmd.selectionStart === gdbTermCmd.selectionEnd
          ? ""
          : gdbTermCmd.value.slice(gdbTermCmd.selectionStart, gdbTermCmd.selectionEnd),
      getEditable: () => gdbTermCmd
    });
    gdbTermCmd.addEventListener("input", () => autoResizeCmd());
    window.addEventListener("resize", () => autoResizeCmd());
    autoResizeCmd();
    gdbTermCmd.addEventListener("keydown", (e) => {
      if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        const hasSelection = gdbTermCmd.selectionStart !== gdbTermCmd.selectionEnd;
        if (hasSelection) {
          return; // let browser copy selected text
        }
        e.preventDefault();
        vscode.postMessage({ type: "consoleInterrupt" });
        return;
      }
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        sendBuffer();
        return;
      }
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        if (gdbHistory.length === 0) {
          return;
        }
        if (gdbHistIndex === gdbHistory.length) {
          gdbHistDraft = normalizeBuffer();
        }
        if (gdbHistIndex > 0) {
          gdbHistIndex -= 1;
          gdbTermCmd.value = gdbHistory[gdbHistIndex];
          autoResizeCmd();
        }
        return;
      }
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        if (gdbHistory.length === 0) {
          return;
        }
        if (gdbHistIndex < gdbHistory.length - 1) {
          gdbHistIndex += 1;
          gdbTermCmd.value = gdbHistory[gdbHistIndex];
          autoResizeCmd();
        } else {
          gdbHistIndex = gdbHistory.length;
          gdbTermCmd.value = gdbHistDraft;
          autoResizeCmd();
        }
      }
    });
  }

  if (termOut) {
    buildContextMenu(termOut, {
      getSelectionText: () => window.getSelection()?.toString() ?? ""
    });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "term") {
      if (msg.consoleAppend && termOut) {
        termOut.textContent += msg.consoleAppend;
        termOut.scrollTop = termOut.scrollHeight;
      }
      if (msg.consoleClear && termOut) {
        termOut.textContent = "";
      }
    }
  });

  vscode.postMessage({ type: "gdbTermReady" });
})();
