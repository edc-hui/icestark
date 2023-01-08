import Sandbox from '@ice/sandbox';
import { getGlobalProp, noteGlobalProps } from './global';
import { Asset, fetchScripts, AssetTypeEnum, appendExternalScript } from './handleAssets';
import { getLifecyleByLibrary, getLifecyleByRegister } from './getLifecycle';
import { asyncForEach, isDev } from './helpers';
import { ErrorCode, formatErrMessage } from './error';
import { PREFIX } from './constant';

import type { ModuleLifeCycle } from '../apps';

/**
 * 采用eval函数去执行js
 * @param scripts
 * @param sandbox
 * @param globalwindow
 */
function executeScripts(scripts: string[], sandbox?: Sandbox, globalwindow: Window = window) {
  let libraryExport = null;

  for (let idx = 0; idx < scripts.length; ++idx) {
    const lastScript = idx === scripts.length - 1;
    if (lastScript) {
      noteGlobalProps(globalwindow);
    }

    if (sandbox?.execScriptInSandbox) {
      sandbox.execScriptInSandbox(scripts[idx]); // 子应用开启了沙箱，则在沙箱中执行js
    } else {
      // https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/eval
      // eslint-disable-next-line no-eval
      (0, eval)(scripts[idx]); // 未开启沙箱的子应用，则通过eval 执行子应用的js
    }

    if (lastScript) {
      libraryExport = getGlobalProp(globalwindow);
    }
  }

  return libraryExport;
}

/**
 * 通过fetch的方式去加载子应用的js
 */
export function loadScriptByFetch(jsList: Asset[], sandbox?: Sandbox, fetch = window.fetch) {
  return fetchScripts(jsList, fetch) // fetchScripts 获取js
    .then((scriptTexts) => {
      const globalwindow = getGobalWindow(sandbox);

      const libraryExport = executeScripts(scriptTexts, sandbox, globalwindow); // executeScripts 执行js

      let moduleInfo = getLifecyleByLibrary() || getLifecyleByRegister();
      if (!moduleInfo) {
        moduleInfo = (libraryExport ? globalwindow[libraryExport] : {}) as ModuleLifeCycle;

        if (globalwindow[libraryExport]) {
          delete globalwindow[libraryExport];
        }
      }

      return moduleInfo;
    });
}

/**
 * Get globalwindow
 *
 * @export
 * @param {Sandbox} [sandbox]
 * @returns
 */
export function getGobalWindow(sandbox?: Sandbox) {
  if (sandbox?.getSandbox) {
    // 开启了sandbox的话，则去创建沙箱的代理对象并返回
    sandbox.createProxySandbox();
    return sandbox.getSandbox();
  }
  // FIXME: If run in Node environment
  return window;
}

/**
 * 加载 es modules 子应用并且获取顺序的生命周期.
 * `import` returns a promise for the module namespace object of the requested module which means
 * + non-export returns empty object
 * + default export return object with `default` key
 */
export async function loadScriptByImport(jsList: Asset[]): Promise<null | ModuleLifeCycle> {
  let mount = null;
  let unmount = null;
  await asyncForEach(jsList, async (js, index) => {
    if (js.type === AssetTypeEnum.INLINE) { // 加载行内js
      await appendExternalScript(js, {
        id: `${PREFIX}-js-module-${index}`,
      });
    } else { // 加载外部js
      let dynamicImport = null;
      try {
        /**
        * 使用 new Function 去检测浏览器是否支持import 函数导入js的语法
        * Then use `new Function` to escape compile error.
        * Inspired by [dynamic-import-polyfill](https://github.com/GoogleChromeLabs/dynamic-import-polyfill)
        */
        // eslint-disable-next-line no-new-func
        dynamicImport = new Function('url', 'return import(url)');
      } catch (e) {
        return Promise.reject(
          new Error(
            formatErrMessage(
              ErrorCode.UNSUPPORTED_IMPORT_BROWSER,
              isDev && 'You can not use loadScriptMode = import where dynamic import is not supported by browsers.',
            ),
          ),
        );
      }

      try {
        if (dynamicImport) {
          // 使用import函数去导入es module的js
          const { mount: maybeMount, unmount: maybeUnmount } = await dynamicImport(js.content);

          if (maybeMount && maybeUnmount) {
            mount = maybeMount;
            unmount = maybeUnmount;
          }
        }
      } catch (e) {
        return Promise.reject(e);
      }
    }
  });

  if (mount && unmount) {
    return {
      mount,
      unmount,
    };
  }

  return null;
}
