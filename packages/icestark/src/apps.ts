import Sandbox, { SandboxConstructor, SandboxProps } from '@ice/sandbox';
import isEmpty from 'lodash.isempty';
import { NOT_LOADED, NOT_MOUNTED, LOADING_ASSETS, UNMOUNTED, LOAD_ERROR, MOUNTED } from './util/constant';
import findActivePathCurry, { ActivePath, PathOption, formatPath } from './util/checkActive';
import {
  createSandbox,
  getUrlAssets,
  getEntryAssets,
  loadAndAppendCssAssets,
  loadAndAppendJsAssets,
  emptyAssets,
  filterRemovedAssets,
  Assets,
} from './util/handleAssets';
import { setCache } from './util/cache';
import { loadScriptByFetch, loadScriptByImport } from './util/loaders';
import { getLifecyleByLibrary, getLifecyleByRegister } from './util/getLifecycle';
import { mergeFrameworkBaseToPath, getAppBasename, shouldSetBasename, log, isDev } from './util/helpers';
import { ErrorCode, formatErrMessage } from './util/error';
import globalConfiguration, { temporaryState } from './util/globalConfiguration';

import type { StartConfiguration } from './util/globalConfiguration';
import type { FindActivePathReturn } from './util/checkActive';

export type ScriptAttributes = string[] | ((url: string) => string[]);

const importCachedAssets: {
  [index: string]: HTMLElement[];
} = {};

interface LifecycleProps {
  container: HTMLElement | string;
  customProps?: object;
}

type LoadScriptMode = 'fetch' | 'script' | 'import';

export interface ModuleLifeCycle {
  mount?: (props: LifecycleProps) => Promise<void> | void;
  unmount?: (props: LifecycleProps) => Promise<void> | void;
  update?: (props: LifecycleProps) => Promise<void> | void;
  bootstrap?: (props: LifecycleProps) => Promise<void> | void;
}

export interface BaseConfig extends PathOption {
  name?: string;
  url?: string | string[];
  activePath?: ActivePath;
  container?: HTMLElement;
  status?: string;
  sandbox?: boolean | SandboxProps | SandboxConstructor;
  entry?: string;
  entryContent?: string;
  /**
  * basename is used for setting custom basename for child's basename.
  */
  basename?: string;
  /**
   * will be deprecated in future version, use `loadScriptMode` instead.
   * @see loadScriptMode
   * @deprecated
   */
  umd?: boolean;
  loadScriptMode?: LoadScriptMode;
  /**
   * @private will be prefixed with `_` for it is internal.
   */
  findActivePath?: FindActivePathReturn;
  appAssets?: Assets;
  props?: object;
  cached?: boolean;
  title?: string;
  /**
   * custom script attributes，only effective when scripts load by `<scrpit />`
   */
  scriptAttributes?: ScriptAttributes;
}

interface LifeCycleFn {
  (app: AppConfig): void;
}

interface AppLifecylceOptions {
  beforeMount?: LifeCycleFn;
  afterMount?: LifeCycleFn;
  beforeUnmount?: LifeCycleFn;
  afterUnmount?: LifeCycleFn;
  beforeUpdate?: LifeCycleFn;
  afterUpdate?: LifeCycleFn;
}

export interface AppConfig extends BaseConfig {
  appLifecycle?: AppLifecylceOptions;
  appSandbox?: Sandbox;
}

export interface MicroApp extends AppConfig, ModuleLifeCycle {
  configuration?: StartConfiguration;
}

// cache all microApp
let microApps: MicroApp[] = []; // 全局 microApps 数组变量，用于缓存所有的微应用
(window as any).microApps = microApps;

function getAppNames() {
  return microApps.map((app) => app.name);
}

export function getMicroApps() {
  return microApps;
}

export function getAppStatus(appName: string) {
  const app = microApps.find((microApp) => appName === microApp.name);
  return app ? app.status : '';
}

/**
 * 注册子应用
 * @param appConfig
 * @param appLifecyle
 */
export function registerMicroApp(appConfig: AppConfig, appLifecyle?: AppLifecylceOptions) {
  // check appConfig.name
  if (getAppNames().includes(appConfig.name)) {
    throw Error(`name ${appConfig.name} already been regsitered`);
  }

  const { activePath, hashType = false, exact = false, sensitive = false, strict = false } = appConfig;

  /**
   * Format activePath in advance
   */
  const activePathArray = formatPath(activePath, {
    hashType,
    exact,
    sensitive,
    strict,
  });

  const { basename: frameworkBasename } = globalConfiguration;

  const findActivePath = findActivePathCurry(mergeFrameworkBaseToPath(activePathArray, frameworkBasename));

  const microApp = {
    status: NOT_LOADED,
    ...appConfig,
    appLifecycle: appLifecyle,
    findActivePath,
  };

  microApps.push(microApp); // 向全局 microApps 数组变量插入子应用
}

export function registerMicroApps(appConfigs: AppConfig[], appLifecyle?: AppLifecylceOptions) {
  appConfigs.forEach((appConfig) => {
    registerMicroApp(appConfig, appLifecyle);
  });
}

export function getAppConfig(appName: string) {
  return microApps.find((microApp) => microApp.name === appName);
}

export function updateAppConfig(appName: string, config) {
  microApps = microApps.map((microApp) => {
    if (microApp.name === appName) {
      return {
        ...microApp,
        ...config,
      };
    }
    return microApp;
  });
}

/**
 * 加载子应用的核心逻辑
 * @param appConfig 子应用的配置信息
 * @returns
 */
export async function loadAppModule(appConfig: AppConfig) {
  const { onLoadingApp, onFinishLoading, fetch } = getAppConfig(appConfig.name)?.configuration || globalConfiguration;

  let lifecycle: ModuleLifeCycle = {};
  onLoadingApp(appConfig); // 执行子应用开始加载的回调 onLoadingApp
  const { url, container, entry, entryContent, name, scriptAttributes = [], loadScriptMode, appSandbox } = appConfig;
  // 根据配置的子应用的url 或者entry去获取子应用的静态资源文件对应的url地址
  const appAssets = url ? getUrlAssets(url) : await getEntryAssets({
    root: container,
    entry,
    href: location.href,
    entryContent,
    assetsCacheKey: name,
    fetch,
  });

  updateAppConfig(appConfig.name, { appAssets }); // 更新子应用的配置信息

  const cacheCss = shouldCacheCss(loadScriptMode); // 是否要缓存css

  switch (loadScriptMode) {
    case 'import': // 说明是ESM应用
      await loadAndAppendCssAssets([
        ...appAssets.cssList,
        ...filterRemovedAssets(importCachedAssets[name] || [], ['LINK', 'STYLE']),
      ], {
        cacheCss,
        fetch,
      });
      lifecycle = await loadScriptByImport(appAssets.jsList);
      // Not to handle script element temporarily.
      break;
    case 'fetch':
      await loadAndAppendCssAssets(appAssets.cssList, {
        cacheCss,
        fetch,
      });
      lifecycle = await loadScriptByFetch(appAssets.jsList, appSandbox, fetch);
      break;
    default:
      await Promise.all([
        loadAndAppendCssAssets(appAssets.cssList, {
          cacheCss,
          fetch,
        }),
        loadAndAppendJsAssets(appAssets, { scriptAttributes }),
      ]);
      lifecycle =
          getLifecyleByLibrary() ||
          getLifecyleByRegister() ||
          {};
  }

  if (isEmpty(lifecycle)) {
    log.error(
      formatErrMessage(
        ErrorCode.EMPTY_LIFECYCLES,
        isDev && 'Unable to retrieve lifecycles of {0} after loading it',
        appConfig.name,
      ),
    );
  }

  onFinishLoading(appConfig); // 执行子应用加载完成的回调 onLoadingApp

  return combineLifecyle(lifecycle, appConfig);
}

function capitalize(str: string) {
  if (typeof str !== 'string') return '';
  return `${str.charAt(0).toUpperCase()}${str.slice(1)}`;
}

async function callAppLifecycle(primaryKey: string, lifecycleKey: string, appConfig: AppConfig) {
  if (appConfig.appLifecycle && appConfig.appLifecycle[`${primaryKey}${capitalize(lifecycleKey)}`]) {
    await appConfig.appLifecycle[`${primaryKey}${capitalize(lifecycleKey)}`](appConfig);
  }
}

function combineLifecyle(lifecycle: ModuleLifeCycle, appConfig: AppConfig) {
  const combinedLifecyle = { ...lifecycle };
  ['mount', 'unmount', 'update'].forEach((lifecycleKey) => {
    if (lifecycle[lifecycleKey]) {
      combinedLifecyle[lifecycleKey] = async (props) => {
        await callAppLifecycle('before', lifecycleKey, appConfig);
        await lifecycle[lifecycleKey](props);
        await callAppLifecycle('after', lifecycleKey, appConfig);
      };
    }
  });
  return combinedLifecyle;
}

function shouldCacheCss(mode: LoadScriptMode) {
  return temporaryState.shouldAssetsRemoveConfigured ? false : (mode !== 'script');
}

function registerAppBeforeLoad(app: AppConfig, options?: AppLifecylceOptions) {
  const { name } = app; // 取出子应用的唯一标识
  const appIndex = getAppNames().indexOf(name); // 查看存储所有子应用的全局变量中是否有当前子应用

  if (appIndex === -1) {
    registerMicroApp(app, options); // 注册子应用
  } else {
    updateAppConfig(name, app);
  }

  return getAppConfig(name);
}

/**
 * 加载子应用
 * @param app
 */
async function loadApp(app: MicroApp) {
  const { title, name, configuration } = app;

  if (title) {
    document.title = title; // 更改页面的标题
  }

  updateAppConfig(name, { status: LOADING_ASSETS }); // 更新子应用的状态为正在加载资源 LOADING_ASSETS

  let lifeCycle: ModuleLifeCycle = {};
  try {
    lifeCycle = await loadAppModule(app); // 加载子应用的js和css资源
    // in case of app status modified by unload event
    if (getAppStatus(name) === LOADING_ASSETS) {
      updateAppConfig(name, { ...lifeCycle, status: NOT_MOUNTED }); // 更新子应用的状态为未挂载
    }
  } catch (err) {
    configuration.onError(err);
    log.error(err);
    updateAppConfig(name, { status: LOAD_ERROR }); // 更新子应用的状态为加载错误
  }
  if (lifeCycle.mount) {
    await mountMicroApp(name); // 子应用静态资源获取完成后执行挂载App
  }
}

function mergeThenUpdateAppConfig(name: string, configuration?: StartConfiguration) {
  const appConfig = getAppConfig(name);

  if (!appConfig) {
    return;
  }

  const { umd, sandbox } = appConfig;

  // Generate appSandbox
  const appSandbox = createSandbox(sandbox) as Sandbox;

  // Merge loadScriptMode
  const sandboxEnabled = sandbox && !appSandbox.sandboxDisabled;
  const loadScriptMode = appConfig.loadScriptMode ?? (umd || sandboxEnabled ? 'fetch' : 'script');

  // Merge global configuration
  const cfgs = {
    ...globalConfiguration,
    ...configuration,
  };

  updateAppConfig(name, {
    appSandbox,
    loadScriptMode,
    configuration: cfgs,
  });
}

export async function createMicroApp(
  app: string | AppConfig,
  appLifecyle?: AppLifecylceOptions,
  configuration?: StartConfiguration,
) {
  const appName = typeof app === 'string' ? app : app.name; // 获取子应用的唯一标识

  if (typeof app !== 'string') {
    registerAppBeforeLoad(app, appLifecyle); // 这一步其实就是将子应用放到全局变量microApps之中
  }

  mergeThenUpdateAppConfig(appName, configuration); // 合并更新子应用的配置信息

  const appConfig = getAppConfig(appName); // 获取子应用的配置信息

  if (!appConfig || !appName) {
    console.error(`[icestark] fail to get app config of ${appName}`);
    return null;
  }

  const { container, basename, activePath, configuration: userConfiguration, findActivePath } = appConfig;

  if (container) {
    setCache('root', container); // 缓存子应用的的根DOM节点
  }

  const { fetch } = userConfiguration;

  if (shouldSetBasename(activePath, basename)) {
    let pathString = findActivePath(window.location.href);

    // When use `createMicroApp` lonely, `activePath` maybe not provided.
    pathString = typeof pathString === 'string' ? pathString : '';
    setCache('basename', getAppBasename(pathString, basename));
  }

  switch (appConfig.status) { // 子应用的status
    case NOT_LOADED: // 未加载
    case LOAD_ERROR: // 加载错误
      await loadApp(appConfig);
      break;
    case UNMOUNTED: // 已卸载
      if (!appConfig.cached) {
        const appendAssets = [
          ...(appConfig?.appAssets?.cssList || []),
          // In vite development mode, styles are inserted into DOM manually.
          // While es module natively imported twice may never excute twice.
          // https://github.com/ice-lab/icestark/issues/555
          ...(appConfig?.loadScriptMode === 'import' ? filterRemovedAssets(importCachedAssets[appConfig.name] ?? [], ['LINK', 'STYLE']) : []),
        ];

        await loadAndAppendCssAssets(appendAssets, {
          cacheCss: shouldCacheCss(appConfig.loadScriptMode),
          fetch,
        });
      }
      await mountMicroApp(appConfig.name);
      break;
    case NOT_MOUNTED: // 未挂载
      await mountMicroApp(appConfig.name);
      break;
    default:
      break;
  }

  return getAppConfig(appName); // 返回要注册的子应用配置信息
}

/**
 * 执行子应用挂载的生命周期函数
 * @param appName
 */
export async function mountMicroApp(appName: string) {
  const appConfig = getAppConfig(appName);
  // check current url before mount
  const shouldMount = appConfig?.mount && appConfig?.findActivePath(window.location.href);

  if (shouldMount) {
    // 执行子应用的挂载生命周期函数
    if (appConfig?.mount) {
      await appConfig.mount({ container: appConfig.container, customProps: appConfig.props });
    }
    // 更新子应用的状态为已挂载
    updateAppConfig(appName, { status: MOUNTED });
  }
}

/**
 * 卸载子应用----此时子应用的资源都还在
 * @param appName 子应用的唯一标识
 */
export async function unmountMicroApp(appName: string) {
  const appConfig = getAppConfig(appName); // 获取子应用配置
  if (appConfig && (appConfig.status === MOUNTED || appConfig.status === LOADING_ASSETS || appConfig.status === NOT_MOUNTED)) {
    // 如果子应用没有设置缓存，则直接移除子应用的资源
    const { shouldAssetsRemove } = getAppConfig(appName)?.configuration || globalConfiguration;
    // 将子应用的资源全部从document文档上面移除掉
    const removedAssets = emptyAssets(shouldAssetsRemove, !appConfig.cached && appConfig.name);

    /**
    * Since es module natively imported twice may never excute twice. https://dmitripavlutin.com/javascript-module-import-twice/
    * Cache all child's removed assets, then append them when app is mounted for the second time.
    * Only cache removed assets when app's loadScriptMode is import which may not cause break change.
    */
    if (appConfig.loadScriptMode === 'import') {
      importCachedAssets[appName] = removedAssets;
    }

    updateAppConfig(appName, { status: UNMOUNTED }); // 更新子应用的状态为已卸载
    if (!appConfig.cached && appConfig.appSandbox) {
      appConfig.appSandbox.clear(); // 移除子应用的沙箱
      appConfig.appSandbox = null;
    }
    if (appConfig.unmount) { // 执行子应用卸载的生命周期函数
      await appConfig.unmount({ container: appConfig.container, customProps: appConfig.props });
    }
  }
}

/**
 * 卸载子应用的同时，还会把子应用的静态资源从配置上删除掉
 * @param appName
 */
export async function unloadMicroApp(appName: string) {
  const appConfig = getAppConfig(appName);
  if (appConfig) {
    unmountMicroApp(appName);
    delete appConfig.mount;
    delete appConfig.unmount;
    delete appConfig.appAssets; // 删除子应用的静态资源
    updateAppConfig(appName, { status: NOT_LOADED }); // 更新子应用的状态为未下载资源状态
  } else {
    log.error(
      formatErrMessage(
        ErrorCode.CANNOT_FIND_APP,
        isDev && 'Can not find app {0} when call {1}',
        appName,
        'unloadMicroApp',
      ),
    );
  }
}

/**
 * 将子应用从全局变量microApps中移除掉
 * @param appName
 */
export function removeMicroApp(appName: string) {
  const appIndex = getAppNames().indexOf(appName); // 拿到子应用在microApps数组中的索引
  if (appIndex > -1) {
    // unload micro app in case of app is mounted
    unloadMicroApp(appName); // 为了防止子应用处于已挂载状态，要先卸载子应用
    microApps.splice(appIndex, 1); // 从microApps中移除该子应用的配置
  } else {
    log.error(
      formatErrMessage(
        ErrorCode.CANNOT_FIND_APP,
        isDev && 'Can not find app {0} when call {1}',
        appName,
        'removeMicroApp',
      ),
    );
  }
}

export function removeMicroApps(appNames: string[]) {
  appNames.forEach((appName) => {
    removeMicroApp(appName);
  });
}

/**
 * 清空子应用
 */
export function clearMicroApps() {
  getAppNames().forEach((name) => {
    unloadMicroApp(name);
  });
  microApps = [];
}
