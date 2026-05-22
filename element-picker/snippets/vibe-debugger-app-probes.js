// Optional app-side helpers for the Element Picker QA Bridge Vibe Debugger.
// Copy this file into a dev-only app utility, or import it from a local path.

function getApi() {
  return typeof window !== 'undefined' ? window.__VIBE_DEBUGGER__ : null;
}

export function vibeTrace(name, payload) {
  getApi()?.trace(name, payload);
}

export function vibeWatch(name, value, options) {
  getApi()?.watch(name, value, options);
}

export function vibeVisibility(name, payload) {
  getApi()?.visibility(name, payload);
}

export function vibeAction(name, payload) {
  getApi()?.action(name, payload);
}

export function createReactVibeHooks(React) {
  const { useEffect, useRef } = React;

  function useVibeWatch(name, value, options) {
    const previousJsonRef = useRef('');

    useEffect(() => {
      let json = '';
      try {
        json = JSON.stringify(value);
      } catch {
        json = String(value);
      }

      if (json === previousJsonRef.current) return;
      previousJsonRef.current = json;
      vibeWatch(name, value, options);
    }, [name, value, options]);
  }

  function useVibeVisibility(name, visible, details) {
    useEffect(() => {
      vibeVisibility(name, { visible, ...details });
    }, [name, visible, details]);
  }

  return {
    useVibeWatch,
    useVibeVisibility,
  };
}

export function createReduxVibeMiddleware(options = {}) {
  const label = options.label || 'Redux';
  const select = typeof options.select === 'function' ? options.select : (state) => state;

  return (store) => (next) => (action) => {
    vibeAction(`${label}.${action?.type || 'action'}`, {
      action,
      before: select(store.getState()),
    });

    const result = next(action);

    vibeWatch(`${label}.state`, select(store.getState()), {
      source: 'redux',
      actionType: action?.type || null,
    });

    return result;
  };
}

export function attachZustandVibe(store, name, selector = (state) => state) {
  if (!store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') {
    return () => {};
  }

  vibeWatch(`${name}.state`, selector(store.getState()), { source: 'zustand', initial: true });

  return store.subscribe((state, previousState) => {
    vibeWatch(`${name}.state`, selector(state), {
      source: 'zustand',
      previous: selector(previousState),
    });
  });
}

export function attachQueryClientVibe(queryClient, name = 'ReactQuery') {
  const queryCache = queryClient?.getQueryCache?.();
  if (!queryCache || typeof queryCache.subscribe !== 'function') {
    return () => {};
  }

  return queryCache.subscribe((event) => {
    const query = event?.query;
    vibeTrace(`${name}.${event?.type || 'query'}`, {
      queryHash: query?.queryHash || null,
      queryKey: query?.queryKey || null,
      state: query?.state
        ? {
          status: query.state.status,
          fetchStatus: query.state.fetchStatus,
          dataUpdatedAt: query.state.dataUpdatedAt,
          errorUpdatedAt: query.state.errorUpdatedAt,
        }
        : null,
    });
  });
}
