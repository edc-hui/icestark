/* eslint-disable max-lines */
/* eslint-disable no-param-reassign */
import urlParse from 'url-parse';
import Sandbox, { SandboxProps, SandboxConstructor } from '@ice/sandbox';
import { PREFIX, DYNAMIC, STATIC, IS_CSS_REGEX } from './constant';
import { toArray, isDev, formatMessage, builtInScriptAttributesMap, looseBoolean2Boolean, isElement, log } from './helpers';
import { formatErrMessage, ErrorCode } from './error';
import type { Fetch } from './globalConfiguration';
import type { ScriptAttributes } from '../apps';

const COMMENT_REGEX = /<!--.*?-->/g;
const BASE_LOOSE_REGEX = /<base\s[^>]*href=['"]?([^'"]*)['"]?[^>]*>/;

const EMPTY_STRING = '';
const STYLESHEET_LINK_TYPE = 'stylesheet';

const cachedScriptsContent: object = {};
const cachedStyleContent: object = {};
const cachedProcessedContent: object = {};

const defaultFetch = window?.fetch.bind(window);

export enum AssetTypeEnum {
  INLINE = 'inline',
  EXTERNAL = 'external',
}

export enum AssetCommentEnum {
  REPLACED = 'replaced',
  PROCESSED = 'processed',
}

export interface Asset {
  module?: boolean;
  type: AssetTypeEnum;
  content: string;
}

export interface ProcessedContent {
  html: HTMLElement;
  assets: Assets;
}

export interface Assets {
  jsList: Asset[];
  cssList: Array<Asset | HTMLElement>;
}

export interface ParsedConfig {
  origin: string;
  pathname: string;
}

// Lifecycle Props
export interface ILifecycleProps {
  container: HTMLElement;
  customProps?: object;
}

function isAssetExist(element: HTMLScriptElement | HTMLLinkElement, type: 'script' | 'link') {
  const urlAlias = type === 'script' ? 'src' : 'href';

  return Array.from(document.getElementsByTagName(type))
    .some((item) => {
      if (
        item[urlAlias]
        && element[urlAlias] === item[urlAlias]
      ) {
        return true;
      }
      return false;
    });
}

/**
 * 创建 link/style 元素 接受子应用的css资源 并且 插入 到 主应用的head标签内部
 */
export function appendCSS(
  root: HTMLElement | ShadowRoot,
  asset: Asset | HTMLElement,
  id: string,
): Promise<void> {
  return new Promise<void>(async (resolve, reject) => {
    if (!root) reject(new Error('no root element for css asset'));

    if (isElement(asset)) { // asset 是DOM 的话，直接插入即可
      root.append(asset);
      resolve();
      return;
    }

    const { type, content } = asset;

    if (type && type === AssetTypeEnum.INLINE) { // 行内样式的话直接插入到style标签即可
      const styleElement: HTMLStyleElement = document.createElement('style');
      styleElement.id = id;
      styleElement.setAttribute(PREFIX, DYNAMIC);
      styleElement.innerHTML = content;
      root.appendChild(styleElement);
      resolve();
      return;
    }

    /**
     * if external resource is cached by prefetch, use cached content instead.
     * For cachedStyleContent may fail to fetch (cors, and so on)，recover to original way
     */
    let useExternalLink = true;
    if (type && type === AssetTypeEnum.EXTERNAL && cachedStyleContent[content]) { // 从缓存中，直接取出样式资源并插入到主应用的head标签即可
      try {
        const styleElement: HTMLStyleElement = document.createElement('style');
        styleElement.innerHTML = await cachedStyleContent[content];
        styleElement.id = id;
        styleElement.setAttribute(PREFIX, DYNAMIC);
        root.appendChild(styleElement);
        useExternalLink = false;
        resolve();
      } catch (e) {
        useExternalLink = true;
      }
    }

    if (useExternalLink) { // 说明是需要外部链接样式资源
      const element: HTMLLinkElement = document.createElement('link');
      element.setAttribute(PREFIX, DYNAMIC);
      element.id = id;
      element.rel = 'stylesheet';
      element.href = content;

      // 监听元素加载错误情况
      element.addEventListener(
        'error',
        () => {
          log.error(
            formatErrMessage(
              ErrorCode.CSS_LOAD_ERROR,
              isDev && 'The stylesheets loaded error: {0}',
              (content || asset) as string,
            ),
          );
          return resolve();
        },
        false,
      );
      // 监听元素加载完成
      element.addEventListener('load', () => resolve(), false);

      // 将link标签插入到主应用的head标签内部
      root.appendChild(element);
    }
  });
}

/**
 * append custom attribute for element
 */
function setAttributeForScriptNode(element: HTMLScriptElement, {
  module,
  id,
  src,
  scriptAttributes,
}: {
  module: boolean;
  id: string;
  src: string;
  scriptAttributes: ScriptAttributes;
}) {
  /*
  * stamped by icestark for recycle when needed.
  */
  element.setAttribute(PREFIX, DYNAMIC);
  element.id = id;


  element.type = module ? 'module' : 'text/javascript';
  element.src = src;

  // 保证外部script按照顺序加载
  element.async = false;

  /**
  * `type` is allowed to set as `module`, `nomodule` and so on.
  */
  const unableReachedAttributes = [PREFIX, 'id', 'src', 'async'];

  const attrs = typeof (scriptAttributes) === 'function'
    ? scriptAttributes(src)
    : scriptAttributes;

  if (!Array.isArray(attrs)) {
    isDev && (
      console.warn(formatMessage('scriptAttributes should be Array or Function that returns Array.'))
    );
    return;
  }

  attrs.forEach((attr) => {
    const [attrKey, attrValue] = attr.split('=');
    if (unableReachedAttributes.includes(attrKey)) {
      (isDev ? console.warn : console.log)(formatMessage(`${attrKey} will be ignored by icestark.`));
      return;
    }

    if (builtInScriptAttributesMap.has(attrKey)) {
      /*
      * built in attribute like ["crossorigin=use-credentials"]、["nomodule"] should be set as follow:
      * script.crossOrigin = 'use-credentials';
      * script.noModule = true;
      */
      const nonLooseBooleanAttrValue = looseBoolean2Boolean(attrValue);
      element[builtInScriptAttributesMap.get(attrKey)] = nonLooseBooleanAttrValue === undefined || nonLooseBooleanAttrValue;
    } else {
      /*
      * none built in attribute added by `setAttribute`
      */
      element.setAttribute(attrKey, attrValue);
    }
  });
}

/**
 * Create script element (without inline) and append to root
 * 创建script标签并插入到主应用的head标签内部
 */
export function appendExternalScript(asset: string | Asset,
  {
    id,
    root = document.getElementsByTagName('head')[0],
    scriptAttributes = [],
  }: {
    id: string;
    root?: HTMLElement | ShadowRoot;
    scriptAttributes?: ScriptAttributes;
  }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { type, content, module } = (asset as Asset);
    // 创建script标签
    const element: HTMLScriptElement = document.createElement('script');
    // 行内 script 代码 直接插入到创建的script标签里面即可
    if (type && type === AssetTypeEnum.INLINE) {
      element.innerHTML = content;
      element.id = id;
      element.setAttribute(PREFIX, DYNAMIC); // 添加icestark=dynamic标识
      module && (element.type = 'module');
      root.appendChild(element);

      /*
      * For inline script never fire onload event, resolve it immediately.
      */
      resolve();
      return;
    }

    // 给script标签设置自定义的属性
    setAttributeForScriptNode(element, {
      module,
      id,
      src: content || (asset as string),
      scriptAttributes,
    });

    if (isAssetExist(element, 'script')) {
      resolve();
      return;
    }

    element.addEventListener(
      'error',
      () => {
        reject(
          new Error(
            formatErrMessage(
              ErrorCode.JS_LOAD_ERROR,
              isDev && 'The script resources loaded error: {0}',
              (content || asset) as string,
            ),
          ),
        );
      },
      false,
    );
    // 监听外部js 加载完成事件
    element.addEventListener('load', () => resolve(), false);

    // 将外部链接的script代码添加至主应用的head标签内
    root.appendChild(element);
  });
}

/**
 * 根据js和css的url去组合成cssList 和 jsList的数据格式
 * @param urls
 */
export function getUrlAssets(urls: string | string[]) {
  const jsList = [];
  const cssList = [];

  toArray(urls).forEach((url) => {
    // //icestark.com/index.css -> true
    // //icestark.com/index.css?timeSamp=1575443657834 -> true
    // //icestark.com/index.css?query=test.js -> false
    const isCss: boolean = IS_CSS_REGEX.test(url); // 判断是不是css url
    const assest: Asset = {
      type: AssetTypeEnum.EXTERNAL, // 给静态资源指定类型，inline / external
      content: url, // 静态资源的url地址
    };
    if (isCss) {
      cssList.push(assest);
    } else {
      jsList.push(assest);
    }
  });

  return { jsList, cssList };
}

/**
 * 通过window.fetch获取js文本
 * @param jsList
 * @param fetch
 */
export function fetchScripts(jsList: Asset[], fetch: Fetch = defaultFetch) {
  return Promise.all(jsList.map((asset) => {
    const { type, content } = asset;
    if (type === AssetTypeEnum.INLINE) { // 对于行内js直接返回
      return content;
    } else { // 对于外部js利用fetch api  获取
      // content will script url when type is AssetTypeEnum.EXTERNAL
      // eslint-disable-next-line no-return-assign
      return cachedScriptsContent[content]
        /**
        * If code is being evaluated as a string with `eval` or via `new Function`，then the source origin
        * will be the page's origin. As a result, `//# sourceURL` appends to the generated code.
        * See https://sourcemaps.info/spec.html
        */
        || (cachedScriptsContent[content] = fetch(content)
          .then((res) => res.text())
          .then((res) => `${res} \n //# sourceURL=${content}`)
        );
    }
  }));
}

// for prefetch
export function fetchStyles(cssList: Asset[], fetch: Fetch = defaultFetch) {
  return Promise.all(
    cssList.map((asset) => {
      const { type, content } = asset;
      if (type === AssetTypeEnum.INLINE) {
        return content;
      }
      // eslint-disable-next-line no-return-assign
      return cachedStyleContent[content] || (cachedStyleContent[content] = fetch(content).then((res) => res.text()));
    }),
  );
}

export function parseUrl(entry: string): ParsedConfig {
  const { origin, pathname } = urlParse(entry);
  return {
    origin,
    pathname,
  };
}

export function startWith(url: string, prefix: string): boolean {
  return url.slice(0, prefix.length) === prefix;
}

export function getUrl(entry: string, relativePath: string): string {
  const { origin, pathname } = parseUrl(entry);

  // https://icestark.com/ice/index.html + ./js/index.js -> https://icestark.com/ice/js/index.js
  if (startWith(relativePath, './')) {
    const rPath = relativePath.slice(1);

    if (!pathname || pathname === '/') {
      return `${origin}${rPath}`;
    }

    const pathArr = pathname.split('/');
    pathArr.splice(-1);
    return `${origin}${pathArr.join('/')}${rPath}`;
  } else if (startWith(relativePath, '/')) {
    // https://icestark.com/ice/index.html + /js/index.js -> https://icestark.com/js/index.js
    return `${origin}${relativePath}`;
  } else {
    // https://icestark.com + js/index.js -> https://icestark.com/js/index.js
    return `${origin}/${relativePath}`;
  }
}

/**
 * If script/link processed by @ice/stark, add comment for it
 */
export function getComment(tag: string, from: string, type: AssetCommentEnum): string {
  return `${tag} ${from} ${type} by @ice/stark`;
}

/**
 * check if link is absolute url
 * @param url
 */
export function isAbsoluteUrl(url: string): boolean {
  return (/^(https?:)?\/\/.+/).test(url);
}

/**
 * Replace processed nodes to comment node.
 */
export function replaceNodeWithComment(node: HTMLElement, comment: string): void {
  if (node?.parentNode) {
    const commentNode = document.createComment(comment);
    node.parentNode.appendChild(commentNode);
    node.parentNode.removeChild(node);
  }
}

/**
* Deal with inline script for es module, like `import refresh from '/@refresh.js'` should be replaced
* by absolute one `import refresh from '/@refresh.js'`.
* Once we hoped ShadowDOM can help, but it's impossible to customize url of shadow root for now.
* https://github.com/WICG/webcomponents/issues/581
*/
export function replaceImportIdentifier(text: string, base: string) {
  let localText = text;
  const importRegex = /import\s+?(?:(?:(?:[\w*\s{},]*)\s+from\s+?)|)(?:(?:"(.*?)")|(?:'(.*?)'))[\s]*?(?:;|$|)/;
  const matches = text.match(new RegExp(importRegex, 'g'));

  if (matches) {
    matches.forEach((matchStr) => {
      const [, doubleQuoteImporter, singleQuoteImporter] = matchStr.match(importRegex);
      const identifier = doubleQuoteImporter || singleQuoteImporter;

      if (!isAbsoluteUrl(identifier)) {
        const absoluteIdentifier = getUrl(base, identifier);
        const replacedImportStatement = matchStr.replace(identifier, absoluteIdentifier);

        localText = text.replace(matchStr, replacedImportStatement);
      }
    });
  }
  return localText;
}

/**
 * 从html字符串中提取子应用DOM结构以及根据entry组合子应用静态资源js与css的url地址
 * @param html
 * @param entry
 */
export function processHtml(html: string, entry?: string): ProcessedContent {
  if (!html) return { html: document.createElement('div'), assets: { cssList: [], jsList: [] } };

  // 通过DOMParser将html字符串获取完整的DOM对象
  const domContent = (new DOMParser()).parseFromString(html.replace(COMMENT_REGEX, ''), 'text/html');

  // 创建base标签，将子应用html中所有相对路径全部变成指向子应用entry的绝对路径
  if (entry) {
    const baseElementMatch = html.match(BASE_LOOSE_REGEX);

    const baseElements = domContent.getElementsByTagName('base');
    const hasBaseElement = baseElements.length > 0;

    if (baseElementMatch && hasBaseElement) {
      // Only take the first one into consideration.
      const baseElement = baseElements[0];

      const [, baseHerf] = baseElementMatch;
      // 将子应用的资源url由相对路径改成带有子应用域名端口号的绝对路径
      baseElement.href = isAbsoluteUrl(baseHerf) ? baseHerf : getUrl(entry, baseHerf);
    } else {
      // add base URI for absolute resource.
      // see more https://developer.mozilla.org/en-US/docs/Web/HTML/Element/base
      const base = document.createElement('base');
      // <base /> element also takes effects if href includues `.html`
      base.href = entry;
      domContent.getElementsByTagName('head')[0].appendChild(base);
    }
  }

  // 获取子应用中所有的script标签
  const scripts = Array.from(domContent.getElementsByTagName('script'));
  const processedJSAssets = scripts.map((script) => {
    const inlineScript = script.src === EMPTY_STRING; // 判断是不是行内script
    const module = script.type === 'module'; // 判断是不是ESModule

    // 获取子应用非行内script的url(entry + 资源路径) ---- 暂且成为外部js
    const externalSrc = !inlineScript && (isAbsoluteUrl(script.src) ? script.src : getUrl(entry, script.src));

    const commentType = inlineScript ? AssetCommentEnum.PROCESSED : AssetCommentEnum.REPLACED;
    // 使用注释来代替script标签节点进行占位
    replaceNodeWithComment(script, getComment('script', inlineScript ? 'inline' : script.src, commentType));

    return {
      module, // ESModule的标识
      type: inlineScript ? AssetTypeEnum.INLINE : AssetTypeEnum.EXTERNAL, // 行内还是外部js
      content:
        inlineScript
          ? (
            // If entryContent provided, skip this.
            (module && entry)
              ? replaceImportIdentifier(script.text, entry)
              : script.text)
          : externalSrc,
    };
  });

  // 获取子应用中所有的style标签
  const inlineStyleSheets = Array.from(domContent.getElementsByTagName('style')); // 获取行内样式
  const externalStyleSheets = Array.from(domContent.getElementsByTagName('link')) // 获取link标签外部样式
    .filter((link) => !link.rel || link.rel.includes(STYLESHEET_LINK_TYPE));

  const processedCSSAssets = [
    ...inlineStyleSheets
      .map((sheet) => {
        replaceNodeWithComment(sheet, getComment('style', 'inline', AssetCommentEnum.REPLACED)); // 使用注释来代替style标签节点
        return {
          type: AssetTypeEnum.INLINE,
          content: sheet.innerText,
        };
      }),
    ...externalStyleSheets
      .map((sheet) => {
        replaceNodeWithComment(sheet, getComment('link', sheet.href, AssetCommentEnum.PROCESSED)); // 使用注释来代替link标签节点
        return {
          type: AssetTypeEnum.EXTERNAL,
          content: isAbsoluteUrl(sheet.href) ? sheet.href : getUrl(entry, sheet.href),
        };
      }),
  ];

  if (entry) {
    // 移除之前为子应用创建的base标签，以此来避免影响主应用
    const baseNodes = domContent.getElementsByTagName('base');
    for (let i = 0; i < baseNodes.length; ++i) {
      baseNodes[i]?.parentNode.removeChild(baseNodes[i]);
    }
  }

  return {
    html: domContent.getElementsByTagName('html')[0], // 子应用的html DOM对象 (此时已经移除了子应用自己全部的script以及css，由icestark注释来代替占位)
    assets: {
      jsList: processedJSAssets, // 子应用js静态资源
      cssList: processedCSSAssets, // 子应用css静态资源
    },
  };
}

/**
 * 通过子应用的ip + 端口号 获取子应用的静态资源并插入到主应用的DOM节点上面
 * @param root
 * @param entry
 * @param entryContent
 * @param assetsCacheKey
 * @param href
 * @param fetch
 */
export async function getEntryAssets({
  root,
  entry,
  entryContent,
  assetsCacheKey,
  href = location.href,
  fetch = defaultFetch,
}: {
  root?: HTMLElement | ShadowRoot; // 子应用要挂载到主应用上的节点
  entry?: string; // 子应用的访问地址 ip + port
  entryContent?: string; // 开发者自己配置的 子应用html结构
  assetsCacheKey: string; // 缓存数据的key值
  href?: string;
  fetch?: Fetch;
  assertsCached?: boolean;
}) {
  const cachedContent = cachedProcessedContent[assetsCacheKey];
  let htmlContent = entryContent;

  if (!cachedContent) {
    if (!htmlContent && entry) {
      if (!fetch) {
        log.warn('Current environment does not support window.fetch, please use custom fetch');
        throw new Error(
          `fetch ${entry} error: Current environment does not support window.fetch, please use custom fetch`,
        );
      }
      // 通过fetch api 根据entry地址获取子应用的html字符串
      htmlContent = await fetch(entry).then((res) => res.text());
    }
    // 缓存子应用的html字符串
    cachedProcessedContent[assetsCacheKey] = htmlContent;
  }

  // 解析html字符串，拿到静态资源的资源的url
  const { html, assets } = processHtml(cachedContent || htmlContent, entry || href);

  if (root) {
    root.appendChild(html); // 将子应用插入到主应用的DOM节点上面
  }

  return assets;
}

/**
 * 获取应用的资源模块， js, css, 资源
 */
export function getAssetsNode(): Array<HTMLStyleElement|HTMLScriptElement> {
  let nodeList = [];
  ['style', 'link', 'script'].forEach((tagName) => {
    nodeList = [...nodeList, ...Array.from(document.getElementsByTagName(tagName))];
  });
  return nodeList;
}

/**
 * Record static assets
 */
export function recordAssets(): void {
  // getElementsByTagName is faster than querySelectorAll
  const assetsList = getAssetsNode();
  assetsList.forEach((assetsNode) => {
    setStaticAttribute(assetsNode);
  });
}

/**
 * If `PREFIX` is setted in `DYNAMIC` type, remain it
 */
export function setStaticAttribute(tag: HTMLStyleElement | HTMLScriptElement): void {
  if (tag.getAttribute(PREFIX) !== DYNAMIC) {
    tag.setAttribute(PREFIX, STATIC);
  }
  tag = null;
}

/**
 * 移除子应用的资源
 * @returns Removed assets.
 */
export function emptyAssets(
  shouldRemove: (
    assetUrl: string,
    element?: HTMLElement | HTMLLinkElement | HTMLStyleElement | HTMLScriptElement,
  ) => boolean,
  cacheKey: string|boolean,
) {
  const removedAssets: HTMLElement[] = []; // 记录已经被移除的子应用静态资源
  // remove extra assets
  //  带有icestark=static的属性是主应用的静态资源，此处利用这个特性可以直接获取到document中子应用的静态资源

  // 获取子应用的全部style标签
  const styleList: NodeListOf<HTMLStyleElement> = document.querySelectorAll(
    `style:not([${PREFIX}=${STATIC}])`,
  );
  // 遍历子应用的style标签进行一个个移除操作
  styleList.forEach((style) => {
    if (shouldRemove(null, style) && checkCacheKey(style, cacheKey)) {
      style.parentNode.removeChild(style);

      removedAssets.push(style);
    }
  });
  // 获取所有的子应用link标签资源
  const linkList: NodeListOf<HTMLLIElement> = document.querySelectorAll(
    `link:not([${PREFIX}=${STATIC}])`,
  );
  // 遍历子应用的link标签进行一个个移除操作
  linkList.forEach((link) => {
    if (shouldRemove(link.getAttribute('href'), link) && checkCacheKey(link, cacheKey)) {
      link.parentNode.removeChild(link);

      removedAssets.push(link);
    }
  });
  // 获取所有的子应用script标签资源
  const jsExtraList: NodeListOf<HTMLScriptElement> = document.querySelectorAll(
    `script:not([${PREFIX}=${STATIC}])`,
  );
  // 遍历子应用的script标签进行一个个移除操作
  jsExtraList.forEach((js) => {
    if (shouldRemove(js.getAttribute('src'), js) && checkCacheKey(js, cacheKey)) {
      js.parentNode.removeChild(js);

      removedAssets.push(js);
    }
  });

  return removedAssets; // 返回被移除的子应用静态资源
}

export function checkCacheKey(node: HTMLElement | HTMLLinkElement | HTMLStyleElement | HTMLScriptElement, cacheKey: string|boolean) {
  return (typeof cacheKey === 'boolean' && cacheKey)
    || !node.getAttribute('cache')
    || node.getAttribute('cache') === cacheKey;
}

/**
 * cache all assets loaded by current sub-application
 */
export function cacheAssets(cacheKey: string): void {
  const assetsList = getAssetsNode();
  assetsList.forEach((assetsNode) => {
    // set cache key if asset attributes without prefix=static and cache
    if (assetsNode.getAttribute(PREFIX) !== STATIC && !assetsNode.getAttribute('cache')) {
      assetsNode.setAttribute('cache', cacheKey);
    }
  });
}

/**
 * 加载并插入 css assets
 *
 * @export
 * @param {Assets} assets
 */
export async function loadAndAppendCssAssets(cssList: Array<Asset | HTMLElement>, {
  cacheCss = false,
  fetch = defaultFetch,
}: {
  cacheCss?: boolean;
  fetch?: Fetch;
}) {
  const cssRoot: HTMLElement = document.getElementsByTagName('head')[0]; // 主应用的head标签

  if (cacheCss) {
    let useLinks = false;
    let cssContents = null;

    try {
      // No need to cache css when running into `<style />`
      const needCachedCss = cssList.filter((css) => !isElement(css));
      cssContents = await fetchStyles(
        needCachedCss as Asset[],
        fetch,
      );
    } catch (e) {
      useLinks = true;
    }

    // Try hard to avoid break-change if fetching links error.
    // And supposed to be remove from 3.x
    if (!useLinks) {
      return await Promise.all([
        ...cssContents.map((content, index) => appendCSS(
          cssRoot,
          { content, type: AssetTypeEnum.INLINE }, `${PREFIX}-css-${index}`,
        )),
        ...cssList.filter((css) => isElement(css)).map((asset, index) => appendCSS(cssRoot, asset, `${PREFIX}-css-${index}`)),
      ]);
    }
  }

  // load css content
  return await Promise.all(
    cssList.map((asset, index) => appendCSS(cssRoot, asset, `${PREFIX}-css-${index}`)),
  );
}

/**
 * 加载并插入 js 资源, compatible with v1
 * @export
 * @param {Assets} assets
 * @param {Sandbox} [sandbox]
 * @returns
 */
export function loadAndAppendJsAssets(
  assets: Assets,
  {
    scriptAttributes = [],
  }: {
    scriptAttributes?: ScriptAttributes;
  },
) {
  const jsRoot: HTMLElement = document.getElementsByTagName('head')[0]; // 获取主应用的head标签

  const { jsList } = assets; // 获取js静态资源

  // 加载js
  const hasInlineScript = jsList.find((asset) => asset.type === AssetTypeEnum.INLINE);
  if (hasInlineScript) {
    // make sure js assets loaded in order if has inline scripts
    return jsList.reduce((chain, asset, index) => {
      return chain.then(() => appendExternalScript(asset, {
        root: jsRoot,
        scriptAttributes,
        id: `${PREFIX}-js-${index}`,
      }));
    }, Promise.resolve());
  }

  return Promise.all(
    jsList.map((asset, index) => appendExternalScript(asset, {
      root: jsRoot,
      scriptAttributes,
      id: `${PREFIX}-js-${index}`,
    })),
  );
}

export function createSandbox(sandbox?: boolean | SandboxProps | SandboxConstructor) {
  // Create appSandbox if sandbox is active
  let appSandbox = null;
  if (sandbox) {
    if (typeof sandbox === 'function') {
      // eslint-disable-next-line new-cap
      appSandbox = new sandbox();
    } else {
      const sandboxProps = typeof sandbox === 'boolean' ? {} : (sandbox as SandboxProps);
      appSandbox = new Sandbox(sandboxProps);
    }
  }
  return appSandbox;
}

/**
 * Get classified assets.
 */
type RemovedAssetType = 'SCRIPT' | 'LINK' | 'STYLE';

export function filterRemovedAssets(assets: HTMLElement[], types: RemovedAssetType[]): Asset[] {
  return assets
    .reduce((pre, element) => {
      // escape stamped element
      if (element.getAttribute(PREFIX) === DYNAMIC) {
        return pre;
      }

      if (types.includes(element.nodeName as RemovedAssetType)) {
        return [
          ...pre,
          element,
        ];
      }

      return pre;
    }, []);
}

