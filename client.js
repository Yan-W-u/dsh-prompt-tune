window.__ModuleLoader__.load({
  id: 'dsh-prompt-tune',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const NS = 'dsh-prompt-tune';

    const zh = {
      'pill.idle': '优化',
      'pill.idle.title': '把当前提示词改写成一版更精确、可直接执行的提示词',
      'pill.busy': '优化中',
      'pill.busy.title': '正在用当前模型改写提示词…',
      'pill.undo': '还原',
      'pill.undo.title': '恢复优化前的原文',
      'pill.empty': '先写点什么',
      'pill.empty.title': '输入框是空的，没有可优化的内容',
      'pill.same': '已经够清楚了',
      'pill.done.title': '已改写，可点击还原',
      'error.request': '优化失败',
      'error.network': '连不上优化接口，确认 harness 还在运行后刷新页面',
      'error.empty': '提示词为空',
    };

    const en = {
      'pill.idle': 'Optimize',
      'pill.idle.title': 'Rewrite the current prompt into a precise, execution-ready one',
      'pill.busy': 'Optimizing',
      'pill.busy.title': 'Rewriting with the live model route…',
      'pill.undo': 'Undo',
      'pill.undo.title': 'Restore the original text',
      'pill.empty': 'Nothing to optimize',
      'pill.empty.title': 'The composer is empty',
      'pill.same': 'Already precise',
      'pill.done.title': 'Rewritten — click to undo',
      'error.request': 'Optimization failed',
      'error.network': 'Cannot reach the optimizer route; refresh once the harness is running',
      'error.empty': 'Empty prompt',
    };

    const T = { zh, en };

    /**
     * One optimizer call against the Host route.
     * @param {string} text - current draft.
     * @param {string} sessionId - Session whose live route should win.
     * @returns {{ ok: boolean, text?: string, error?: string }}
     */
    async function optimize(text, sessionId) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 90000)
        : undefined;
      try {
        const response = await fetch(new URL('/prompt-tune/optimize', window.location.origin).toString(), {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, sessionId }),
          signal: controller ? controller.signal : undefined,
        });
        const raw = await response.text();
        let data;
        try { data = raw ? JSON.parse(raw) : {}; } catch {
          return { ok: false, error: `${response.status} ${raw.slice(0, 120)}` };
        }
        if (!response.ok || !data || data.ok !== true) {
          return { ok: false, error: (data && data.error) || `${response.status} ${response.statusText}` };
        }
        return { ok: true, text: String(data.text || '') };
      } catch (error) {
        if (controller && controller.signal.aborted) return { ok: false, error: 'timeout' };
        const message = String((error && error.message) || error);
        return {
          ok: false,
          error: /failed to fetch|networkerror|load failed/i.test(message) ? 'network' : message,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function PromptTunePill(props) {
      const t = props.t;
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const draft = props.useInput
        ? props.useInput((state) => (state && typeof state.draft === 'string' ? state.draft : ''))
        : '';

      const [phase, setPhase] = useState('idle'); // idle | busy | undo | notice
      const [notice, setNotice] = useState('');
      const [hover, setHover] = useState(false);
      const originalRef = useRef('');
      const aliveRef = useRef(true);
      const noticeTimer = useRef(0);
      const undoTimer = useRef(0);

      useEffect(() => () => {
        aliveRef.current = false;
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        if (undoTimer.current) clearTimeout(undoTimer.current);
      }, []);

      const showNotice = useCallback((message) => {
        setNotice(message);
        setPhase('notice');
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => {
          if (!aliveRef.current) return;
          setPhase('idle');
          setNotice('');
        }, 2600);
      }, []);

      const applyDraft = useCallback((text) => {
        try {
          if (inputActions && typeof inputActions.setDraft === 'function') {
            inputActions.setDraft(text);
            return true;
          }
        } catch { /* ignore */ }
        return false;
      }, [inputActions]);

      /* Manual edits after a rewrite drop the undo offer: the stored original
         no longer corresponds to what the user sees. */
      const appliedRef = useRef('');
      useEffect(() => {
        if (phase !== 'undo') return;
        const now = typeof draft === 'string' ? draft : '';
        if (appliedRef.current && now !== appliedRef.current) {
          if (undoTimer.current) clearTimeout(undoTimer.current);
          appliedRef.current = '';
          setPhase('idle');
        }
      }, [draft, phase]);

      const run = useCallback(async () => {
        if (phase === 'busy') return;

        if (phase === 'undo') {
          if (undoTimer.current) clearTimeout(undoTimer.current);
          const restored = applyDraft(originalRef.current);
          appliedRef.current = '';
          setPhase('idle');
          if (!restored) showNotice(t('error.request'));
          return;
        }

        const text = typeof draft === 'string' ? draft : '';
        if (text.trim().length === 0) {
          showNotice(t('pill.empty'));
          return;
        }

        setPhase('busy');
        const result = await optimize(text, sessionId);
        if (!aliveRef.current) return;

        if (!result.ok) {
          showNotice(result.error === 'network'
            ? t('error.network')
            : t('error.request') + '：' + (result.error || ''));
          return;
        }
        if (result.text.trim().length === 0 || result.text === text) {
          setPhase('idle');
          showNotice(t('pill.same'));
          return;
        }

        originalRef.current = text;
        const applied = applyDraft(result.text);
        if (!applied) {
          setPhase('idle');
          showNotice(t('error.request'));
          return;
        }
        appliedRef.current = result.text;
        setPhase('undo');
        if (undoTimer.current) clearTimeout(undoTimer.current);
        undoTimer.current = setTimeout(() => {
          if (!aliveRef.current) return;
          appliedRef.current = '';
          setPhase('idle');
        }, 8000);
      }, [phase, draft, sessionId, applyDraft, showNotice, t]);

      const empty = draft.trim().length === 0;

      const label = phase === 'busy'
        ? t('pill.busy')
        : phase === 'undo'
          ? t('pill.undo')
          : phase === 'notice'
            ? notice
            : t('pill.idle');

      const title = phase === 'busy'
        ? t('pill.busy.title')
        : phase === 'undo'
          ? t('pill.undo.title')
          : phase === 'notice'
            ? notice
            : t('pill.idle.title');

      const accent = 'var(--dsw-alias-brand-primary, #247bbf)';

      return h('button', {
        type: 'button',
        'data-prompt-tune': 'pill',
        'aria-label': title,
        title,
        disabled: phase === 'busy',
        onClick: run,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 26,
          padding: '0 9px',
          marginRight: 4,
          borderRadius: 13,
          border: '1px solid ' + (phase === 'busy' || phase === 'undo' || hover
            ? accent
            : 'var(--dsw-alias-border-l1, rgba(127,127,127,0.32))'),
          background: phase === 'busy'
            ? 'color-mix(in srgb, ' + accent + ' 16%, transparent)'
            : 'transparent',
          color: phase === 'undo' ? accent : 'var(--dsw-alias-label-secondary, #666)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '1',
          cursor: phase === 'busy' ? 'default' : 'pointer',
          opacity: empty && phase !== 'undo' && phase !== 'busy' ? 0.55 : 1,
          maxWidth: 260,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          transition: 'border-color .15s ease, color .15s ease, background .15s ease',
          userSelect: 'none',
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          display: 'inline-block',
          width: 11,
          height: 11,
          color: phase === 'busy' || phase === 'undo' ? accent : 'inherit',
          animation: phase === 'busy' ? 'dsh-prompt-tune-spin 1.1s linear infinite' : 'none',
        },
        dangerouslySetInnerHTML: {
          __html: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.6 1.6M11 11l1.6 1.6M12.6 3.4L11 5M5 11L3.4 12.6"/><circle cx="8" cy="8" r="1.9"/></svg>',
        },
      }), h('span', null, label));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, T), 'dsh-prompt-tune: dictionaries');

        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-dsh-prompt-tune', 'styles');
          style.textContent = '@keyframes dsh-prompt-tune-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
          document.head.appendChild(style);
          return () => { try { style.remove(); } catch { /* ignore */ } };
        }, 'dsh-prompt-tune: keyframes');

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'prompt-tune',
          order: 30,
          inject: (sessionId) => ({
            sessionId,
            t: ctx.locale.bind(NS),
          }),
        }, PromptTunePill));
      },
    };
  },
});
