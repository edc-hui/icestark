import urlParse from 'url-parse';
import {
  routingEventsListeningTo,
  isInCapturedEventListeners,
  addCapturedEventListeners,
  removeCapturedEventListeners,
  callCapturedEventListeners,
  createPopStateEvent,
  setHistoryEvent,
} from './util/capturedListeners';
import { AppConfig, getMicroApps, createMicroApp, unmountMicroApp, clearMicroApps } from './apps';
import { emptyAssets, recordAssets } from './util/handleAssets';
import { LOADING_ASSETS, MOUNTED } from './util/constant';
import { doPrefetch } from './util/prefetch';
import globalConfiguration, { temporaryState } from './util/globalConfiguration';
import { ErrorCode, formatErrMessage } from './util/error';
import { isDev } from './util/helpers';
import type { RouteType, StartConfiguration } from './util/globalConfiguration';

if (!window?.fetch) {
  throw new Error(
    formatErrMessage(
      ErrorCode.UNSUPPORTED_FETCH,
      isDev && 'window.fetch not found, you need to polyfill it!',
    ),
  );
}

interface OriginalStateFunction {
  (state: any, title: string, url?: string): void;
}

let started = false;
const originalPush: OriginalStateFunction = window.history.pushState; // 储存原始pushState方法
const originalReplace: OriginalStateFunction = window.history.replaceState; // 储存原始replaceState方法
const originalAddEventListener = window.addEventListener; // 储存原始事件监听方法
const originalRemoveEventListener = window.removeEventListener; // 储存原始移除事件监听方法

const handleStateChange = (event: PopStateEvent, url: string, method: RouteType) => {
  setHistoryEvent(event);
  globalConfiguration.reroute(url, method);
};

const urlChange = (event: PopStateEvent | HashChangeEvent): void => {
  setHistoryEvent(event);
  globalConfiguration.reroute(location.href, event.type as RouteType);
};

let lastUrl = null; // 记录上次浏览器输入的的url

/**
 * 监听到路由的变化之后，比对路由前后是否发生变化，以此来控制子应用的加载与卸载
 * @param url
 * @param type
 */
export function reroute(url: string, type: RouteType | 'init' | 'popstate' | 'hashchange') {
  const { pathname, query, hash } = urlParse(url, true); // 解析出url中的参数
  if (lastUrl !== url) { // 前后路由进行比对
    globalConfiguration.onRouteChange(url, pathname, query, hash, type); // 触发路由变化事件

    const unmountApps = []; // 储存要卸载的子应用
    const activeApps = []; // 储存要加载的子应用
    // 获取全局中储存的所有子应用进行遍历，分出哪些子应用要卸载，哪些子应用要加载
    getMicroApps().forEach((microApp: AppConfig) => {
      const shouldBeActive = !!microApp.findActivePath(url);
      if (shouldBeActive) {
        activeApps.push(microApp);
      } else {
        unmountApps.push(microApp);
      }
    });
    // 子应用开始被激活的回调
    globalConfiguration.onActiveApps(activeApps);

    // call captured event after app mounted
    Promise.all(
      // call unmount apps
      unmountApps.map(async (unmountApp) => {
        if (unmountApp.status === MOUNTED || unmountApp.status === LOADING_ASSETS) {
          globalConfiguration.onAppLeave(unmountApp); // 子应用卸载前的回调
        }
        // 根据子应用唯一标识去卸载子应用
        await unmountMicroApp(unmountApp.name);
      }).concat(activeApps.map(async (activeApp) => {
        if (activeApp.status !== MOUNTED) {
          globalConfiguration.onAppEnter(activeApp); // 子应用渲染前的回调
        }
        // 加载子应用
        await createMicroApp(activeApp);
      })),
    ).then(() => {
      // 子应用发生了卸载与加载，说明路由变化了，故在这里要去执行下开发者自己对popostate以及hashchange的监听事件
      callCapturedEventListeners();
    });
  }
  lastUrl = url;
}

/**
 * Hijack window.history
 */
const hijackHistory = (): void => {
  window.history.pushState = (state: any, title: string, url?: string, ...rest) => {
    originalPush.apply(window.history, [state, title, url, ...rest]);
    const eventName = 'pushState';
    handleStateChange(createPopStateEvent(state, eventName), url, eventName);
  };

  window.history.replaceState = (state: any, title: string, url?: string, ...rest) => {
    originalReplace.apply(window.history, [state, title, url, ...rest]);
    const eventName = 'replaceState';
    handleStateChange(createPopStateEvent(state, eventName), url, eventName);
  };

  window.addEventListener('popstate', urlChange, false);
  window.addEventListener('hashchange', urlChange, false);
};

/**
 * Unhijack window.history
 */
const unHijackHistory = (): void => {
  window.history.pushState = originalPush;
  window.history.replaceState = originalReplace;

  window.removeEventListener('popstate', urlChange, false);
  window.removeEventListener('hashchange', urlChange, false);
};

/**
 * Hijack eventListener
 */
const hijackEventListener = (): void => {
  window.addEventListener = (eventName, fn, ...rest) => {
    if (
      typeof fn === 'function' &&
      routingEventsListeningTo.indexOf(eventName) >= 0 &&
      !isInCapturedEventListeners(eventName, fn)
    ) {
      addCapturedEventListeners(eventName, fn);
      return;
    }

    return originalAddEventListener.apply(window, [eventName, fn, ...rest]);
  };

  window.removeEventListener = (eventName, listenerFn, ...rest) => {
    if (typeof listenerFn === 'function' && routingEventsListeningTo.indexOf(eventName) >= 0) {
      removeCapturedEventListeners(eventName, listenerFn);
      return;
    }

    return originalRemoveEventListener.apply(window, [eventName, listenerFn, ...rest]);
  };
};

/**
 * Unhijack eventListener
 */
const unHijackEventListener = (): void => {
  window.addEventListener = originalAddEventListener;
  window.removeEventListener = originalRemoveEventListener;
};

function start(options?: StartConfiguration) {
  // See https://github.com/ice-lab/icestark/issues/373#issuecomment-971366188
  // todos: remove it from 3.x
  if (options?.shouldAssetsRemove && !temporaryState.shouldAssetsRemoveConfigured) {
    temporaryState.shouldAssetsRemoveConfigured = true;
  }

  if (started) {
    console.log('icestark has been already started');
    return;
  }
  started = true; // 设置icestark的启动状态为true

  recordAssets(); // 通过'style', 'link', 'script'标签 找到document文档树上的DOM节点，并添加icestark=static属性

  // update globalConfiguration
  globalConfiguration.reroute = reroute; // 路由变化事件
  Object.keys(options || {}).forEach((configKey) => {
    globalConfiguration[configKey] = options[configKey];
  });

  const { prefetch, fetch } = globalConfiguration;
  if (prefetch) { // 说明要进行子应用的预加载
    doPrefetch(getMicroApps(), prefetch, fetch);
  }

  // hajack history & eventListener
  hijackHistory(); // 改写pushState 和 replaceState事件
  hijackEventListener(); // 改写原生的事件监听以及原生的移除事件监听

  // trigger init router
  globalConfiguration.reroute(location.href, 'init');
}

function unload() {
  unHijackEventListener(); // 恢复原生的绑定事件
  unHijackHistory(); // 恢复原生的pushState 与 replaceState
  started = false; // 设置icestark的启动状态为false
  // remove all assets added by micro apps
  emptyAssets(globalConfiguration.shouldAssetsRemove, true);
  clearMicroApps(); // 全局储存子应用的数组置为空数组
}

export { unload, globalConfiguration };
export default start;
