// Helpers every app screen shares, as a `WaasView` global (inlined by view.ts after the MCP Apps bundle).
{
  const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = globalThis.McpApps;

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  }

  /** A store's or backup's status as [label, css class]. */
  function status(item) {
    if (item.isSuspended) return ['Suspended', 'suspended'];
    return [['Pending', 'Done', 'Failed', 'Removing'][item.statusCode] ?? item.statusName ?? '?', ['pending', 'done', 'failed', 'pending'][item.statusCode] ?? ''];
  }

  const pill = (item) => {
    const [label, cls] = status(item);
    return el('span', { className: `pill ${cls}`, textContent: label });
  };

  function message(text, isError = false) {
    $('status').textContent = text;
    $('status').className = isError ? 'msg error' : 'msg';
  }

  const errorText = (result, fallback) => result?.content?.[0]?.text ?? fallback;

  /**
   * Starts a screen: `show` gets each tool result (the first one, and every refresh), `refresh`
   * calls the screen's tool again. Returns the app and a `button` maker for actions.
   */
  async function start({ name, show, refresh }) {
    const app = new App({ name, version: '0.1.0' }, {});
    const armed = new Set();
    let render = () => {};

    const link = (domain) => {
      const a = el('a', { href: `https://${domain}`, textContent: domain });
      a.addEventListener('click', (e) => { e.preventDefault(); app.openLink({ url: a.href }); });
      return a;
    };

    async function reload() {
      $('refresh').disabled = true;
      try {
        show(await refresh(app));
      } catch (e) {
        show({ isError: true, content: [{ text: String(e) }] });
      } finally {
        $('refresh').disabled = false;
      }
    }

    // An action button: calls a server tool, then reloads. Destructive ones need a second click within 4 seconds.
    function button({ key, label, tool, args, destructive = false, what }) {
      const button = el('button', { textContent: armed.has(key) ? `Confirm ${label.toLowerCase()}` : label, className: armed.has(key) ? 'confirm' : '' });
      button.addEventListener('click', async () => {
        if (destructive && !armed.has(key)) {
          armed.add(key);
          render();
          setTimeout(() => { armed.delete(key); render(); }, 4000);
          return;
        }
        armed.delete(key);
        button.disabled = true;
        button.textContent = '…';
        const result = await app.callServerTool({ name: tool, arguments: args }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
        if (result.isError) {
          message(errorText(result, `${label} failed`), true);
        } else {
          app.updateModelContext?.({ content: [{ type: 'text', text: `User clicked "${label}" for ${what} in the ${name} screen.` }] }).catch(() => {});
        }
        await reload();
        if (result.isError) message(errorText(result, `${label} failed`), true);
      });
      return button;
    }

    app.addEventListener('toolresult', show);
    app.addEventListener('hostcontextchanged', () => applyContext(app.getHostContext()));
    $('refresh').addEventListener('click', reload);
    await app.connect();
    applyContext(app.getHostContext());
    return { app, button, link, reload, setRender: (fn) => { render = fn; } };
  }

  globalThis.WaasView = { $, el, status, pill, message, errorText, start };
}
