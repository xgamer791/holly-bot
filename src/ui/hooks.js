import { createContext, useContext, useEffect, useReducer, useState, useRef, useCallback } from '../../vendor/preact.js';

export const AppCtx = createContext(null);
export const UiCtx = createContext(null);

export const useApp = () => useContext(AppCtx);
export const useUi = () => useContext(UiCtx);

/** Re-render when any of the app event topics fire. */
export function useTopics(topics) {
  const app = useApp();
  const [, force] = useReducer((x) => x + 1, 0);
  const key = topics.filter(Boolean).join('|');
  useEffect(() => {
    const offs = topics.filter(Boolean).map((t) => app.on(t, force));
    return () => offs.forEach((off) => off());
  }, [key]);
}

/** Load async data and reload when topics fire. Loads can overlap (a reload
 * every few seconds, a slow connection): only the latest one's answer is
 * kept, so an older one arriving late can't put back what it read. */
export function useAsync(fn, deps = [], topics = []) {
  const app = useApp();
  const [state, setState] = useState({ data: undefined, loading: true, error: null });
  const alive = useRef(true);
  const latest = useRef(0);
  const run = useCallback(async () => {
    const n = ++latest.current;
    try {
      const data = await fn();
      if (alive.current && n === latest.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (alive.current && n === latest.current) setState((s) => ({ data: s.data, loading: false, error }));
    }
  }, deps);
  useEffect(() => {
    alive.current = true;
    run();
    const offs = topics.filter(Boolean).map((t) => app.on(t, run));
    return () => {
      alive.current = false;
      offs.forEach((off) => off());
    };
  }, [run, topics.join('|')]);
  return { ...state, reload: run };
}

/** Messages of a thread, live. */
export function useMessages(threadId) {
  const app = useApp();
  const [list, setList] = useState(() => app.messageCache.get(threadId) || null);
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    let alive = true;
    app.loadMessages(threadId).then((rows) => alive && setList(rows));
    const off = app.on(`messages:${threadId}`, () => {
      if (!alive) return;
      setList(app.messageCache.get(threadId) || []);
      force();
    });
    return () => {
      alive = false;
      off();
    };
  }, [threadId]);
  return list;
}

export function useMedia(query) {
  const get = () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

