// Claude Chat Exporter — exports a claude.ai conversation to a markdown file.
//
// Approach: read the conversation straight from claude.ai's own internal API
// (the same endpoint the app uses), which returns every message's *source
// markdown* — tables, math, code, and all — in order, complete, with an explicit
// human/assistant label. There is no DOM scraping, no copy-button clicking, no
// clipboard interception, and no scrolling: a single same-origin fetch (using the
// user's existing session) is transformed into markdown and downloaded.
//
// Why not the DOM? The rendered page is a lossy derivative of this markdown, only
// shows a virtualized window of long conversations, and couples the script to
// CSS selectors that change constantly. The API is a far more stable data
// contract. See CLAUDE.md for the response shape.
function setupClaudeExporter() {
  let conversationData = null;

  // Non-fatal warnings collected during the run — logged to the console and
  // summarised in the status box, so a degraded export never looks fully clean.
  const warnings = [];
  const warn = (msg) => { console.warn(msg); warnings.push(msg); };
  // tool_use names that were skipped (not rendered) — logged once, to help spot a
  // new content-bearing tool the registry should learn about.
  const skippedTools = new Set();
  // Image attachments on the exported branch, collected by describeAttachments:
  // [{ url, name }]. Fetched and downloaded next to the .md by startExport.
  const images = [];

  // Replace characters that are invalid in Windows filenames or break an
  // Obsidian wikilink.
  function safeFileName(name) {
    return name.replace(/[<>:"/\\|?*\[\]#^\x00-\x1f]/g, '_');
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    try {
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      URL.revokeObjectURL(a.href); // revoke even if the click throws (avoids a leak)
    }
  }

  // Fetch every collected image (same-origin, with the user's session) before
  // anything is downloaded, so a failure aborts the export instead of leaving a
  // .md with dangling image links. The preview endpoint has been observed to
  // return WebP whatever the upload's format (a PNG came back as image/webp), so
  // links are written as .webp and anything else fails rather than being saved
  // under the wrong extension.
  async function fetchImages() {
    const result = [];
    for (const image of images) {
      let response;
      try {
        response = await fetch(image.url, { credentials: 'include' });
      } catch (error) {
        throw new Error(`Image "${image.name}": couldn't be fetched (${error.message}).`);
      }
      if (!response.ok) throw new Error(`Image "${image.name}": fetch failed (HTTP ${response.status}).`);

      const blob = await response.blob();
      if (blob.type !== 'image/webp') {
        throw new Error(`Image "${image.name}": server returned ${blob.type || 'an unknown type'}, expected image/webp.`);
      }
      result.push({ blob, name: image.name });
    }
    return result;
  }

  // Check that an API timestamp is present and parseable; fail fast otherwise.
  // `what` names the field in the error message. Returns the original string.
  function requireTimestamp(isoString, what) {
    if (typeof isoString !== 'string' || isNaN(Date.parse(isoString))) {
      throw new Error(`Invalid or missing timestamp: ${what} (${JSON.stringify(isoString)}).`);
    }
    return isoString;
  }

  // Format an API timestamp in the reader's locale and time zone.
  function formatTimestamp(isoString, what) {
    return new Date(requireTimestamp(isoString, what)).toLocaleString();
  }

  // Fetch the full conversation from Claude's internal API. Same-origin request
  // authenticated by the user's existing session cookie; returns title, ordered
  // messages, per-message timestamps and content blocks. See CLAUDE.md.
  async function fetchConversationData() {
    const conversationId = window.location.pathname.split('/').pop();
    const orgId = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1];

    // A Claude conversation id is a UUID; anything else (e.g. /new, /projects) means
    // the user isn't on a specific conversation.
    if (!conversationId || conversationId.length < 20 || !conversationId.includes('-')) {
      throw new Error('Open a specific Claude conversation first (the current page has no conversation id).');
    }
    if (!orgId) {
      throw new Error("Couldn't read your Claude session (lastActiveOrg cookie missing) — are you signed in?");
    }

    const url = `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;

    let response;
    try {
      response = await fetch(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      throw new Error(`Couldn't reach the Claude API: ${error.message}`);
    }

    if (!response.ok) {
      const hint = (response.status === 401 || response.status === 403)
        ? ' — your session may have expired; reload and sign in'
        : '';
      throw new Error(`Claude API request failed (HTTP ${response.status})${hint}.`);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Couldn't parse the Claude API response: ${error.message}`);
    }
  }

  // Turn the API response into an ordered list of visible turns:
  // [{ sender, text, created_at, truncated, stop_reason }] in conversation order.
  //
  // Ordering: the API returns a message *tree*. We follow the current branch by
  // walking from current_leaf_message_uuid up the parent_message_uuid chain and
  // reversing — this exports exactly the path shown on screen even when a
  // response was regenerated. Falls back to sorting by `index` if the leaf is
  // missing.
  //
  // Content: a message's `content` is an array of typed blocks (text, thinking,
  // tool_use, tool_result). We walk them in order, emitting `text` blocks, `thinking`
  // blocks (renderThinking) and the content-bearing `tool_use` blocks (artifacts /
  // created files / widgets, via renderToolUse) so text and special elements stay
  // interleaved; `tool_result` is skipped and any other type aborts the export.
  // Messages that end up empty are dropped (the API also returns hidden/system
  // messages the UI never shows).
  function getOrderedMessages(data) {
    const all = data?.chat_messages || [];
    if (!all.length) return [];

    const byUuid = new Map(all.map(m => [m.uuid, m]));
    let ordered = null;

    const leaf = data.current_leaf_message_uuid;
    if (leaf && byUuid.has(leaf)) {
      const path = [];
      const seen = new Set();
      let cur = byUuid.get(leaf);
      while (cur && !seen.has(cur.uuid)) {
        seen.add(cur.uuid);
        path.push(cur);
        cur = cur.parent_message_uuid ? byUuid.get(cur.parent_message_uuid) : null;
      }
      if (path.length) ordered = path.reverse();
    }

    if (!ordered) {
      warn('Could not resolve the current branch (current_leaf_message_uuid missing/unresolved) — falling back to index order, which may be inaccurate for branched conversations.');
      ordered = [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }

    // Reconstruct each artifact's final state up-front so it can be rendered once,
    // at its last edit (see collectArtifacts / renderToolUse).
    const artifacts = collectArtifacts(ordered);

    const messages = [];
    const unexpectedSenders = new Set();
    for (const m of ordered) {
      if (m.sender != null && m.sender !== 'human' && m.sender !== 'assistant') {
        unexpectedSenders.add(m.sender);
      }

      // Walk the content blocks in order so text and special elements (artifacts,
      // created files, charts/widgets) stay interleaved exactly as written. Only
      // `text`, `thinking` and content-bearing `tool_use` blocks produce output;
      // `tool_result` blocks are skipped. Any other block type is new to us and
      // aborts the export rather than silently dropping its content.
      const parts = [];
      for (const block of (m.content || [])) {
        if (block.type === 'text') {
          if (typeof block.text !== 'string') {
            throw new Error(`Text block in message ${m.uuid} has no text.`);
          }
          parts.push(block.text.trim());
        } else if (block.type === 'tool_use') {
          parts.push(renderToolUse(block, artifacts));
        } else if (block.type === 'thinking') {
          parts.push(renderThinking(block));
        } else if (block.type !== 'tool_result') {
          throw new Error(`Unknown content block type "${block.type}" in message ${m.uuid}.`);
        }
      }

      // Message-level uploads (images/docs the human attached) sit above the text,
      // mirroring the UI; prepend them, then the in-order content parts.
      const attachments = describeAttachments(m);
      const text = [attachments, ...parts].filter(Boolean).join('\n\n').trim();

      if (!text) continue; // genuinely empty (hidden/system) message

      messages.push({
        sender: m.sender,
        text,
        uuid: m.uuid,
        created_at: m.created_at,
        truncated: !!m.truncated,
        stop_reason: m.stop_reason
      });
    }

    if (unexpectedSenders.size) {
      warn(`Unexpected sender value(s): ${[...unexpectedSenders].join(', ')} — labelled as "Claude".`);
    }
    if (skippedTools.size) {
      // Debug level: hidden from normal users (Chrome shows it only in "Verbose"),
      // but lets a maintainer spot a new content-bearing tool the registry should handle.
      console.debug('[claude-chat-exporter] tools skipped (not rendered):', [...skippedTools].join(', '));
    }

    return messages;
  }

  // A code fence longer than any backtick run in the source, so content that
  // contains its own fences can't close ours early.
  function fenceFor(src) {
    return '`'.repeat(Math.max(3, ...(src.match(/`+/g) || []).map(s => s.length + 1)));
  }

  // Human-readable byte size, e.g. "4.7 KB".
  function formatBytes(n) {
    if (n == null || isNaN(n)) return null;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Represent a message's attachments as markdown, placed above its text.
  //
  // The API stores attachments in two places, handled by what each actually offers:
  //   • m.files       — uploaded files. Images carry a preview_url (downloaded
  //                     next to the .md and embedded as ![[name]]);
  //                     documents (e.g. PDF) carry document_asset.url (linked);
  //                     blobs (e.g. audio) have no usable URL (named marker).
  //   • m.attachments — text extractions (.md/.docx/.txt/.html/…). No URL, but the
  //                     extracted text itself is present, so it is inlined in a
  //                     code fence — its own headings stay fenced, keeping them out
  //                     of the document outline. This is what makes an export
  //                     self-contained for reading and for RAG.
  //
  // File URLs are same-origin claude.ai endpoints: they load only while signed in
  // to the same account. Document links therefore only work while signed in.
  function describeAttachments(m) {
    const toAbsolute = (u) => {
      if (!u || typeof u !== 'string') return null;
      try { return new URL(u, 'https://claude.ai').href; } catch { return null; }
    };
    const meta = (...bits) => bits.filter(Boolean).join(' · ');

    const parts = [];

    for (const file of (m.files || [])) {
      const name = file.file_name || 'file';

      if (file.file_kind === 'image') {
        // claude.ai image URLs only load with the user's session, so the image is
        // downloaded next to the .md and embedded as an Obsidian wikilink. The name
        // is prefixed with part of the file uuid: the browser silently renames a
        // duplicate ("image (1).png"), which would break the link, and pasted
        // images all share similar names.
        const url = toAbsolute(file.preview_url || file.preview_asset?.url);
        if (!url) throw new Error(`Image attachment "${name}" has no preview URL.`);
        if (!file.uuid) throw new Error(`Image attachment "${name}" has no uuid.`);
        // Characters invalid in Windows filenames or that break a wikilink are
        // replaced, and the extension becomes .webp — what the preview returns.
        const safeName = `${file.uuid.slice(0, 8)}_${safeFileName(name.replace(/\.[^.]*$/, ''))}.webp`;
        images.push({ url, name: safeName });
        parts.push(`![[${safeName}]]`); // no label: the image speaks for itself
      } else if (file.file_kind === 'document') {
        const url = toAbsolute(file.document_asset?.url);
        const pages = file.document_asset?.page_count;
        const info = meta('document', pages ? `${pages} page${pages === 1 ? '' : 's'}` : null);
        const nameLink = url ? `[${name}](${url})` : name;
        parts.push(`**Attachment: ${meta(nameLink, info)}**`);
      } else {
        // blob or unknown kind — no reliable URL to link to
        parts.push(`**Attachment: ${meta(name, file.file_kind, formatBytes(file.size_bytes))}**`);
      }
    }

    for (const attachment of (m.attachments || [])) {
      const name = attachment.file_name || attachment.name || 'attachment';
      const info = meta(attachment.file_type, formatBytes(attachment.file_size));
      const label = `**Attachment: ${meta(name, info)}**`;
      const content = typeof attachment.extracted_content === 'string'
        ? attachment.extracted_content.trim()
        : '';

      parts.push(label);
      if (content) {
        // Fence the whole block so the attachment's own headings don't enter the outline
        const fence = fenceFor(content);
        parts.push(`${fence}\n${content}\n${fence}`);
      }
    }

    return parts.join('\n\n');
  }

  // Fold every artifact (keyed by `id`) into its final state. The `artifacts` tool is
  // the only element with a revision model: `create`/`rewrite` carry full `content`;
  // `update` carries an `old_str`→`new_str` diff. We apply them in order and remember
  // the `version_uuid` of each artifact's LAST block, so renderToolUse can emit it once,
  // at its final edit. (Widgets and created files have no linking id and are rendered
  // as-is, each occurrence.)
  function collectArtifacts(ordered) {
    const artifacts = new Map();
    for (const m of ordered) {
      for (const block of (m.content || [])) {
        if (block.type !== 'tool_use' || block.name !== 'artifacts') continue;
        const input = block.input || {};
        const id = input.id || '__artifact__';
        let a = artifacts.get(id);
        if (!a) { a = { content: '' }; artifacts.set(id, a); }

        if (input.command === 'update') {
          if (typeof input.old_str === 'string' && typeof input.new_str === 'string') {
            if (a.content.indexOf(input.old_str) === -1) {
              warn(`Artifact "${a.title || id}": an update couldn't be applied (source text not found) — its content may be incomplete.`);
            } else {
              // Function replacer, not a string: a plain string would interpret `$&`,
              // "$`", `$'` and `$$` in new_str as replacement patterns and silently
              // corrupt the artifact (such sequences occur in real code).
              a.content = a.content.replace(input.old_str, () => input.new_str);
            }
          }
        } else if (typeof input.content === 'string') {
          a.content = input.content; // create / rewrite → full content
        }
        if (input.title) a.title = input.title;      // metadata lives on the create block
        if (input.type) a.type = input.type;
        if (input.language) a.language = input.language;
        a.lastVersionUuid = input.version_uuid;      // last write wins → finalization block
      }
    }

    for (const [id, a] of artifacts) {
      if (!a.content) warn(`Artifact "${a.title || id}" ended up empty — it may not have exported.`);
    }
    return artifacts;
  }

  // Render a `tool_use` block. Only the three content-bearing tools produce output —
  // artifacts, created files, and visualize widgets (charts/diagrams) — each as a
  // titled fenced code block with a kind label drawn from the API. Every other tool
  // (web search, bash, file view/edit, display widgets, unknown) is skipped. Artifacts
  // render once, at their final edit; the reconstructed content comes from `artifacts`.
  function renderToolUse(block, artifacts) {
    const input = block.input || {};
    const name = block.name || '';

    const codeBlock = (label, source, lang) => {
      const fence = fenceFor(source);
      return `**${label}**\n\n${fence}${lang || ''}\n${source}\n${fence}`;
    };

    if (name === 'artifacts') {
      const a = artifacts.get(input.id || '__artifact__');
      // Only the final edit renders; earlier create/update/rewrite blocks emit nothing.
      if (!a || input.version_uuid !== a.lastVersionUuid || !a.content) return '';
      const TYPE = {
        'application/vnd.ant.react': { lang: 'jsx', label: 'React' },
        'text/html': { lang: 'html', label: 'HTML' },
        'image/svg+xml': { lang: 'svg', label: 'SVG' },
        'application/vnd.ant.mermaid': { lang: 'mermaid', label: 'Mermaid' },
        'text/markdown': { lang: 'markdown', label: 'Markdown' },
        'application/vnd.ant.code': { lang: a.language || '', label: a.language || 'Code' }
      };
      const t = TYPE[a.type] || { lang: a.language || '', label: a.language || '' };
      const label = `Artifact: ${a.title || 'untitled'}${t.label ? ` · ${t.label}` : ''}`;
      return codeBlock(label, a.content, t.lang);
    }

    if (name === 'create_file' && typeof input.file_text === 'string' && input.file_text) {
      const file = String(input.path || 'file').split('/').pop();
      const ext = file.includes('.') ? file.split('.').pop().toLowerCase() : '';
      const EXT_LANG = {
        py: 'python', js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
        md: 'markdown', html: 'html', css: 'css', json: 'json', sh: 'bash',
        yml: 'yaml', yaml: 'yaml', sql: 'sql', java: 'java', rb: 'ruby', go: 'go',
        rs: 'rust', c: 'c', cpp: 'cpp', txt: ''
      };
      return codeBlock(`File: ${file}`, input.file_text, EXT_LANG[ext] ?? '');
    }

    if (name === 'visualize:show_widget' && typeof input.widget_code === 'string' && input.widget_code) {
      if (input.widget_code.trim().startsWith('<svg')) {
        // SVG widgets are embedded inline so Obsidian renders the diagram. HTML
        // widgets need claude.ai's runtime, so they stay source code.
        return toInlineSvg(input.widget_code, input.title);
      }
      return codeBlock(`Widget: ${input.title || 'untitled'}`, input.widget_code, 'jsx');
    }

    if (name) skippedTools.add(name); // every other tool is skipped; track for visibility
    return '';
  }

  // Colour ramps for SVG widgets. On claude.ai, widgets rely on classes the page
  // styles (t/ts/th text, arr/leader lines, box, c-{ramp} nodes); that CSS is not
  // in the API, so the styling below is RECONSTRUCTED from the ramp table and
  // class descriptions in the visualize tool's own guidance — an approximation,
  // not claude.ai's actual stylesheet. Stops: 50, 100, 200, 400, 600, 800, 900.
  const RAMPS = {
    purple: ['#EEEDFE', '#CECBF6', '#AFA9EC', '#7F77DD', '#534AB7', '#3C3489', '#26215C'],
    teal: ['#E1F5EE', '#9FE1CB', '#5DCAA5', '#1D9E75', '#0F6E56', '#085041', '#04342C'],
    coral: ['#FAECE7', '#F5C4B3', '#F0997B', '#D85A30', '#993C1D', '#712B13', '#4A1B0C'],
    pink: ['#FBEAF0', '#F4C0D1', '#ED93B1', '#D4537E', '#993556', '#72243E', '#4B1528'],
    gray: ['#F1EFE8', '#D3D1C7', '#B4B2A9', '#888780', '#5F5E5A', '#444441', '#2C2C2A'],
    blue: ['#E6F1FB', '#B5D4F4', '#85B7EB', '#378ADD', '#185FA5', '#0C447C', '#042C53'],
    green: ['#EAF3DE', '#C0DD97', '#97C459', '#639922', '#3B6D11', '#27500A', '#173404'],
    amber: ['#FAEEDA', '#FAC775', '#EF9F27', '#BA7517', '#854F0B', '#633806', '#412402'],
    red: ['#FCEBEB', '#F7C1C1', '#F09595', '#E24B4A', '#A32D2D', '#791F1F', '#501313']
  };

  // Turn a widget's SVG into markup that can sit inline in the markdown, where
  // Obsidian renders it. A <style> block is not an option: it would apply to the
  // whole Obsidian window. Instead each class is resolved to an inline `style` on
  // the element itself. Coloured nodes keep their light-mode ramp colours (a
  // light box with dark text reads well on either theme); free-standing text and
  // lines use Obsidian's theme variables, so they follow light/dark mode. A
  // property the element already sets as an attribute is left alone. onclick
  // handlers (they call a claude.ai function) are dropped, and blank lines are
  // removed — a blank line would end markdown's HTML block mid-SVG.
  function toInlineSvg(code, title) {
    const fail = (what) => { throw new Error(`SVG widget "${title || 'untitled'}": ${what}.`); };
    const doc = new DOMParser().parseFromString(code, 'text/html');
    const svg = doc.body.firstElementChild;
    if (!svg || svg.localName !== 'svg' || doc.body.childElementCount !== 1) fail('not a single <svg> element');

    const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (viewBox.length !== 4 || viewBox.some(isNaN)) fail('missing or invalid viewBox');

    // The ramp a class list names (c-{ramp}), or null; unknown ramps fail.
    const rampOf = (el) => {
      const cls = [...(el?.classList || [])].find(c => c.startsWith('c-'));
      if (!cls) return null;
      if (!RAMPS[cls.slice(2)]) fail(`unknown colour class "${cls}"`);
      return RAMPS[cls.slice(2)];
    };
    const SHAPES = ['rect', 'circle', 'ellipse'];

    const style = (el, props) => {
      const own = Object.entries(props).filter(([p]) => !el.hasAttribute(p)).map(([p, v]) => `${p}:${v}`);
      if (own.length) el.setAttribute('style', own.join(';') + (el.getAttribute('style') ? `;${el.getAttribute('style')}` : ''));
    };

    style(svg, { 'max-width': `${viewBox[2]}px`, 'font-family': 'var(--font-interface)' });

    for (const el of svg.getElementsByTagName('*')) {
      el.removeAttribute('onclick');
      const has = (c) => el.classList.contains(c);
      const parentRamp = rampOf(el.parentElement === svg ? null : el.parentElement);

      if (el.localName === 'text' && (has('t') || has('th') || has('ts'))) {
        const sub = has('ts');
        style(el, {
          'font-size': sub ? '12px' : '14px',
          'font-weight': has('th') ? '500' : '400',
          fill: parentRamp ? parentRamp[sub ? 4 : 5] : (sub ? 'var(--text-muted)' : 'var(--text-normal)')
        });
      } else if (SHAPES.includes(el.localName) && (rampOf(el) || parentRamp)) {
        const r = rampOf(el) || parentRamp;
        style(el, { fill: r[0], stroke: r[4] });
      } else if (has('box')) {
        style(el, { fill: 'var(--background-secondary)', stroke: 'var(--background-modifier-border)' });
      } else if (has('arr')) {
        style(el, { fill: 'none', stroke: 'var(--text-muted)', 'stroke-width': '1.5' });
      } else if (has('leader')) {
        style(el, { fill: 'none', stroke: 'var(--text-faint)', 'stroke-width': '.5', 'stroke-dasharray': '4 3' });
      }
    }

    return svg.outerHTML.replace(/\n\s*\n/g, '\n');
  }

  // Render a `thinking` block as a collapsed callout. Every field it needs must be
  // present and well-formed; anything else means the format changed (or the
  // thinking is hidden/redacted in a way we don't handle yet), so fail fast.
  function renderThinking(block) {
    const fail = (what) => {
      throw new Error(`Unexpected thinking block — ${what}.`);
    };

    if (!Array.isArray(block.summaries) || !block.summaries.length) fail('summaries missing or empty');
    if (!block.summaries.every(s => typeof s?.summary === 'string')) fail('a summary has no text');
    if (typeof block.thinking !== 'string') fail('thinking text missing');
    const start = Date.parse(block.start_timestamp);
    const stop = Date.parse(block.stop_timestamp);
    if (isNaN(start) || isNaN(stop)) fail('start/stop timestamp missing or invalid');

    const lines = [];
    lines.push(`>[!info]- ${block.summaries.map(s => s.summary).join(' ... ')}`);
    lines.push('>');
    lines.push(`> *Thought for ${Math.round((stop - start) / 1000)}s*`);
    lines.push('>');
    lines.push(`> ${block.thinking.replaceAll('\n', '\n> ')}`);
    return lines.join('\n');
  }

  // Render the conversation summary as a collapsed callout. The summary is expected
  // to open with a bold title line ("**Conversation Overview**\n\n"); anything else
  // means the format changed, so fail fast rather than guess.
  function renderSummary(summary) {
    const titleMatch = summary.match(/^\*\*([^*]+)\*\*\n\n/);
    if (!titleMatch) {
      throw new Error('Unexpected summary format — expected it to start with a bold title line.');
    }
    const body = summary.slice(titleMatch[0].length);
    const lines = [];
    lines.push(`>[!summary]- ${titleMatch[1]}`);
    lines.push('>');
    lines.push(`> ${body.replaceAll('\n', '\n> ')}`);
    return lines.join('\n');
  }

  function sanitizeTitle(title) {
    return safeFileName(title).substring(0, 100);
  }

  function getConversationTitle() {
    const title = conversationData?.name?.trim();
    if (title && title !== 'New conversation') {
      return sanitizeTitle(title);
    }
    return 'claude_conversation';
  }

  // YAML double-quoted scalar (escapes backslashes and quotes).
  function yamlString(value) {
    return '"' + String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // A word-based notice appended to an incomplete message (or '' when complete). Only the
  // two signals verified in the API are flagged: `truncated` (rare source-data content
  // truncation) and `stop_reason: 'user_canceled'` (the user stopped the response).
  function incompleteNote(message) {
    if (message.truncated) {
      return '> **Truncated:** the message was truncated in the source data and may be incomplete.';
    }
    if (message.stop_reason === 'user_canceled') {
      return '> **Interrupted:** this response was stopped before Claude finished.';
    }
    return '';
  }

  // Output shape (tuned for RAG ingestion and Obsidian):
  //   • YAML frontmatter carries doc-level metadata (title, source, model, date)
  //     — Obsidian reads it as properties; RAG attaches it to every chunk.
  //   • Each turn is an H1 header, so Claude's own ##/### content nests beneath it
  //     and turn boundaries are the top split level. (No separate title heading or
  //     `---` rules — the frontmatter and headers already delimit everything.)
  function buildMarkdown(messages) {
    const title = conversationData?.name?.trim() || 'Claude conversation';
    const source = window.location.origin + window.location.pathname;

    const frontMatter = ['---', `title: ${yamlString(title)}`, `source: ${yamlString(source)}`];
    if (conversationData?.model) frontMatter.push(`model: ${yamlString(conversationData.model)}`);
    frontMatter.push(`created: ${requireTimestamp(conversationData.created_at, 'conversation created_at')}`);
    frontMatter.push(`modified: ${requireTimestamp(conversationData.updated_at, 'conversation updated_at')}`);
    frontMatter.push(`exported: ${new Date().toISOString()}`, '---', '');

    let markdown = frontMatter.join('\n') + '\n';
    if (conversationData?.summary) {
      markdown += renderSummary(conversationData?.summary);
    }

    // Counted separately because they mean different things to the reader: an
    // interrupted response means nothing is missing (the user stopped it, so there
    // is no more content), whereas `truncated` is a flag whose meaning we can't
    // confirm. Only the latter degrades the status box — see startExport.
    let interrupted = 0;
    let truncated = 0;

    for (const message of messages) {
      const who = message.sender === 'human' ? 'Human' : 'Claude';
      const ts = formatTimestamp(message.created_at, `created_at of message ${message.uuid}`);

      let body = message.text;
      const note = incompleteNote(message);
      if (note) {
        // Mirrors incompleteNote's precedence: `truncated` is checked first and wins.
        if (message.truncated) truncated++; else interrupted++;
        body += `\n\n${note}`;
      }

      var lines = [];
      lines.push(...body.split('\n'));
      lines.push('');
      lines.push(`<div style='text-align:right'>${ts}</div>`);
      if (message.sender === 'human') {
        lines = lines.map(line => `> ${line}`);
        lines.unshift('>[!quote] User');
      }
      markdown += `\n\n---\n\n${lines.join('\n')}`;
    }

    return { markdown, interrupted, truncated };
  }

  // Status indicator. Dark ink because white fails WCAG AA on all four of this
  // box's backgrounds and #1a1a1a passes on all four — don't "restore" it.
  const statusDiv = document.createElement('div');
  statusDiv.setAttribute('role', 'status');
  statusDiv.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 10000;
    background: #2196F3; color: #1a1a1a; padding: 10px 15px;
    border-radius: 5px; font-family: monospace; font-size: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3); max-width: 300px;
    overflow-wrap: anywhere; cursor: pointer; transition: top .15s ease;
  `;

  // Auto-dismiss that only counts down while the page actually has focus, so the
  // box cannot drain away behind a save dialog or the download bubble. The check
  // is on the live focus state rather than on having seen a blur event: the
  // download starts before the result is rendered, so the blur is already spent
  // by the time we would arm.
  let dismissMs = 6000;   // success; the error path lengthens it
  let dismissTimer = null;
  let hovered = false;
  let settled = false;    // nothing auto-dismisses until there is a result to read

  function armDismiss() {
    // The `dismissTimer` guard is load-bearing: without it the tick below would
    // restart the countdown on every pass and the box would never dismiss.
    if (dismissTimer || !settled || hovered || !document.hasFocus()) return;
    dismissTimer = setTimeout(cleanup, dismissMs);
  }

  function pauseDismiss() {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }

  // Housekeeping tick: gates dismissal on real focus, since focus events do not
  // fire reliably around native dialogs, and derives this box's position from
  // whether the update notice is on screen. Deriving it, rather than letting the
  // notice push the box and restore it later, is what stops a superseded notice
  // leaving the box in the wrong place.
  // The interval is set by the reflow, not by the focus check: the notice appears
  // asynchronously and this is what spots it, so anything slower shows a visible
  // overlap before the box steps aside. Both checks are reads, and the write only
  // happens when the position actually changes, so a tick costs nothing.
  const housekeeping = setInterval(() => {
    if (document.hasFocus()) armDismiss(); else pauseDismiss();
    const top = window.__claudeChatExporterNotice ? '70px' : '10px';
    if (statusDiv.style.top !== top) statusDiv.style.top = top;
  }, 100);

  function cleanup() {
    clearInterval(housekeeping);
    clearTimeout(dismissTimer);
    window.removeEventListener('focus', armDismiss);
    window.removeEventListener('blur', pauseDismiss);
    if (document.body.contains(statusDiv)) {
      document.body.removeChild(statusDiv);
    }
    if (window.__claudeChatExporterDispose === cleanup) {
      delete window.__claudeChatExporterDispose;
    }
  }

  statusDiv.addEventListener('mouseenter', () => { hovered = true; pauseDismiss(); });
  statusDiv.addEventListener('mouseleave', () => { hovered = false; armDismiss(); });
  statusDiv.addEventListener('click', cleanup);
  window.addEventListener('focus', armDismiss);
  window.addEventListener('blur', pauseDismiss);

  // Only ever one status box: a new run tears down the previous run's box, timers
  // and window listeners before starting its own. A global marker rather than a
  // lookup, so the script still queries nothing — and it releases the old run's
  // listeners, which finding the element alone would not.
  if (typeof window.__claudeChatExporterDispose === 'function') {
    try { window.__claudeChatExporterDispose(); } catch (_) { /* previous run already gone */ }
  }
  window.__claudeChatExporterDispose = cleanup;
  // The whole contract with the install page's shim, and it is one-directional:
  // the shim announces a notice, this file decides where the box goes. Renaming
  // the marker ends the arrangement silently. Read before the first paint so a
  // box created under an existing notice appears in place rather than sliding.
  if (window.__claudeChatExporterNotice) statusDiv.style.top = '70px';

  document.body.appendChild(statusDiv);

  async function startExport() {
    try {
      statusDiv.textContent = 'Fetching conversation…';
      conversationData = await fetchConversationData();

      // Validate the response shape — a missing chat_messages array means the
      // internal API changed, which we surface clearly rather than as "no messages".
      if (!conversationData || typeof conversationData !== 'object' || !Array.isArray(conversationData.chat_messages)) {
        throw new Error('Unexpected API response — chat_messages is missing (the endpoint may have changed).');
      }

      const messages = getOrderedMessages(conversationData);
      if (!messages.length) {
        const hadContent = conversationData.chat_messages.some(m => Array.isArray(m.content) && m.content.length);
        throw new Error(hadContent
          ? 'No exportable content extracted — the message/content shape may have changed.'
          : 'No messages found in this conversation.');
      }

      const { markdown, interrupted, truncated } = buildMarkdown(messages);
      const filename = `${getConversationTitle()}.md`;

      // All images are fetched before anything is downloaded (see fetchImages).
      if (images.length) statusDiv.textContent = `Fetching ${images.length} image${images.length === 1 ? '' : 's'}…`;
      const imageFiles = await fetchImages();

      downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), filename);
      for (const image of imageFiles) downloadBlob(image.blob, image.name);

      // Two categories, deliberately separated. An interrupted response is a fact
      // about the *conversation* — the export is complete and faithful — so it must
      // not colour the box like a failure. Only `truncated` (whose meaning is
      // unconfirmed, so treated as a warning on precaution) and real processing
      // `warnings` degrade the status.
      const notes = [];
      if (interrupted) notes.push(`${interrupted} interrupted response${interrupted === 1 ? '' : 's'}`);
      if (truncated) notes.push(`${truncated} message${truncated === 1 ? '' : 's'} flagged truncated`);
      if (warnings.length) notes.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'} — see console`);
      const clean = warnings.length === 0 && truncated === 0;
      const imageNote = imageFiles.length ? ` + ${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'}` : '';
      statusDiv.textContent = `${clean ? '✅' : '⚠️'} Exported ${messages.length} messages${imageNote}${notes.length ? ` (${notes.join('; ')})` : ''}: ${filename}`;
      statusDiv.style.background = clean ? '#4CAF50' : '#ff9800';
      // Appended as a node, never innerHTML: the line above interpolates a
      // filename derived from the conversation title, and this file has no HTML
      // sinks. Success only — an error is not the moment to ask for anything.
      // Its own line so a wrapping filename cannot strand it mid-sentence; the
      // rule and the weight, not a colour, are what mark it as an action (red
      // would be near-invisible on green and orange, and is this box's error
      // colour). Underline waits for hover so the resting state stays quiet.
      const support = document.createElement('a');
      support.href = 'https://github.com/sponsors/agarwalvishal';
      support.target = '_blank';
      support.rel = 'noopener';
      support.textContent = '♥ Support this project';
      support.style.cssText = 'display: block; margin-top: 6px; padding-top: 6px; ' +
        'border-top: 1px solid rgba(0,0,0,0.3); color: #1a1a1a; font-weight: 600; ' +
        'text-decoration: none; text-underline-offset: 2px;';
      // mouseenter/mouseleave do not fire when the pointer moves between an
      // element and its own child, so hovering the link leaves the box's
      // hover-pause untouched.
      support.addEventListener('mouseenter', () => { support.style.textDecoration = 'underline'; });
      support.addEventListener('mouseleave', () => { support.style.textDecoration = 'none'; });
      statusDiv.appendChild(support);
      console.log(`🎉 Export complete — ${messages.length} messages → ${filename}`);

    } catch (error) {
      // Set before the text: a live region announces on mutation, not on creation.
      statusDiv.setAttribute('role', 'alert');
      statusDiv.textContent = `Error: ${error.message}`;
      statusDiv.style.background = '#f44336';
      dismissMs = 8000;
      console.error('Export failed:', error);
    } finally {
      settled = true;
      armDismiss();
    }
  }

  startExport();
}

// Run the exporter
setupClaudeExporter();
