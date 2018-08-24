// @flow

import Color from 'color';
import DocsBlockTypes from './DocsBlockTypes';
import DocsCustomStyleMap from './DocsCustomStyleMap';
import DocsDataAttributes from './DocsDataAttributes';
import DocsDecorator from './DocsDecorator';
import DocsDecoratorTypes from './DocsDecoratorTypes';
import asElement from './asElement';
import createDocsTableEntityDataFromElement from './createDocsTableEntityDataFromElement';
import getSafeHTML from './getSafeHTML';
import invariant from 'invariant';
import uniqueID from './uniqueID';
import {CSS_SELECTOR_PRIORITY, CSS_SELECTOR_TEXT} from './getCSSRules';
import {CSS_VARIABLE_CHILD_LIST_ITEM_BEFORE_CONTENT} from './mergeCSSRuleStylesToElement';
import {ContentState, Modifier, EditorState, Entity} from 'draft-js';
import {OrderedSet} from 'immutable';
import {convertFromHTML as draftConvertFromHTML} from 'draft-convert';

import type {DocsTableEntityData, DocsImageEntityData, DocumentLike, ElementLike} from './Types';
import type {SafeHTML} from './getSafeHTML';

// See https://developer.mozilla.org/en-US/docs/Web/CSS/font-weight
const CSS_BOLD_MIN_NUMERIC_VALUE = 500;
const CSS_BOLD_VALUES = new Set(['bold', 'bolder']);
const CSS_NOT_BOLD_VALUES = new Set(['light', 'lighter', 'normal']);
const CSS_BOLD_MIN_NUMERIC_VALUE_PATTERN = /^\d+$/;

// Name of the outermost element used by atomic component.
const ATOMIC_ELEMENT_NODE_NAME = 'figure';

// See https://draftjs.org/docs/advanced-topics-inline-styles.html
const STYLE_BOLD = 'BOLD';

// See https://www.w3schools.com/jsref/prop_node_nodetype.asp
// See https://msdn.microsoft.com/en-us/library/windows/desktop/ms649015
// Note that the pasted HTML may contain HTML comment like
// `<!--StartFragment -->` generated by browser. Developer should check
// `nodeType` to ensure only valid HTML element is used.
const NODE_TYPE_ELEMENT = Node.ELEMENT_NODE;

const ZERO_WIDTH_CHAR = '\u200B';

// Processing HTML is hard, and here are some resources that could be helpful.
// https://goo.gl/4mvkWg : Sample HTML converted into Draft content state
// https://github.com/facebook/draft-js/issues/416#issuecomment-221639163
// https://github.com/draft-js-plugins/draft-js-plugins/pull/474/files
// https://zhuanlan.zhihu.com/p/24951621
// https://github.com/facebook/draft-js/issues/787
// https://github.com/HubSpot/draft-convert#convertfromhtml
// https://zhuanlan.zhihu.com/p/24951621
function convertFromHTML(
  html: string,
  editorState?: ?EditorState,
  domDocument?: ?DocumentLike,
): EditorState {
  // See https://github.com/HubSpot/draft-convert#convertfromhtml
  const safeHTML = getSafeHTML(html, domDocument);
  const handlers = {
    htmlToBlock,
    htmlToEntity,
    htmlToStyle,
    textToEntity,
  };
  Object.keys(handlers).forEach(key => {
    const fn: any = handlers[key];
    handlers[key] = fn.bind(null, safeHTML);
  });
  const contentState = draftConvertFromHTML(handlers)(safeHTML.html);
  const decorator = DocsDecorator.get();
  return editorState ?
    EditorState.push(editorState, contentState) :
    EditorState.createWithContent(contentState, decorator);
}

////////////////////////////////////////////////////////////////////////////////

// Fake DOM Node that is good enough work with. This is faster than using
// a real DOM node.
class FakeAtomicElement {
  _attributes = new Map();
  nodeName = 'FIGURE';
  nodeType = NODE_TYPE_ELEMENT;

  constructor(data: Object) {
    this._attributes.set(
      DocsDataAttributes.ATOMIC_BLOCK_DATA,
      JSON.stringify(data),
    );
  }

  getAttribute(name: string): string {
    return this._attributes.get(name) || '';
  }

  hasAttribute(name: string): boolean {
    return this._attributes.has(name);
  }
}

function htmlToStyle(
  safeHTML: SafeHTML,
  nodeName: string,
  node: Node | ElementLike,
  currentStyle: OrderedSet<string>,
): Object {
  let nextStyle = currentStyle;
  if (node.nodeType !== NODE_TYPE_ELEMENT) {
    // Plain characters.
    return nextStyle;
  }

  const el = asElement(node);
  const {classList, style} = el;
  if (nodeName === ATOMIC_ELEMENT_NODE_NAME && classList && classList.length) {
    // Copy className from atomic node.
    nextStyle = nextStyle.withMutations((style) => {
      classList.forEach((className, ii) => {
        style.add(className);
      });
    });
  }

  // `el.style` could be `null` if `el` is `<math />`.
  if (style) {
    const customStyleHandlers = {
      backgroundColor: DocsCustomStyleMap.forBackgroundColor,
      color: DocsCustomStyleMap.forColor,
      fontSize: DocsCustomStyleMap.forFontSize,
      lineHeight: DocsCustomStyleMap.forLineHeight,
      listStyleImage: DocsCustomStyleMap.forListStyleImage,
      listStyleType: DocsCustomStyleMap.forListStyleType,
      marginLeft: DocsCustomStyleMap.forMarginLeft,
      textAlign: DocsCustomStyleMap.forTextAlign,
    };

    Object.keys(customStyleHandlers).forEach(attr => {
      const styleValue = style[attr];
      if (!styleValue) {
        return;
      }

      const fn = customStyleHandlers[attr];
      const styleName = fn(styleValue);

      if (styleName) {
        nextStyle = nextStyle.add(styleName);
      }
    });
  }

  if (style && style.fontWeight) {
    const {fontWeight} = style;
    // When content is copied from google doc, its HTML may use a tag
    // like `<b style="font-weight: normal">...</b>` which should not make the
    // text bold. This block handles such case.
    // See related issue: https://github.com/facebook/draft-js/issues/481
    if (CSS_BOLD_VALUES.has(fontWeight)) {
      nextStyle = nextStyle.add(STYLE_BOLD);
    } else if (CSS_NOT_BOLD_VALUES.has(fontWeight)) {
      nextStyle = nextStyle.remove(STYLE_BOLD);
    } else if (CSS_BOLD_MIN_NUMERIC_VALUE_PATTERN.test(fontWeight)) {
      nextStyle = parseInt(fontWeight, 10) >= CSS_BOLD_MIN_NUMERIC_VALUE ?
        nextStyle.add(STYLE_BOLD) :
        nextStyle.remove(STYLE_BOLD);
    }
  }

  return nextStyle;
}

function htmlToEntity(
  safeHTML: SafeHTML,
  nodeName: string,
  node: Node,
  createEntity: Function
): ?Entity {
  if (node.nodeType !== NODE_TYPE_ELEMENT) {
    return null;
  }
  let el = asElement(node);
  switch (nodeName) {
    case ATOMIC_ELEMENT_NODE_NAME:
      return htmlToAtomicBlockEntity(safeHTML, nodeName, el, createEntity);

    case 'table':
      el = normalizeNodeForTable(safeHTML, nodeName, el);
      if (el) {
        nodeName = el.nodeName.toLowerCase();
        return htmlToAtomicBlockEntity(safeHTML, nodeName, el, createEntity);
      }
      break;
    case 'a':
      return createEntity(
        DocsDecoratorTypes.LINK,
        'MUTABLE',
        {url: el.href},
      );
  }

  if (!el) {
    return null;
  }

  const valueStr = el.getAttribute(DocsDataAttributes.DECORATOR_DATA);
  let ent;
  if (valueStr) {
    try {
      ent = JSON.parse(valueStr);
    } catch (ex) {
      return null;
    }
  }

  if (!ent) {
    return null;
  }
  return createEntity(
    ent.type,
    ent.mutability,
    ent.data,
  );
}

function htmlToAtomicBlockEntity(
  safeHTML: SafeHTML,
  nodeName: string,
  node: Node | ElementLike,
  createEntity: Function
): ?Entity {
  if (nodeName !== 'figure') {
    return null;
  }
  const element = asElement(node);
  const dataStr = element.getAttribute(DocsDataAttributes.ATOMIC_BLOCK_DATA);
  if (!dataStr) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(dataStr);
  } catch (ex) {
    return null;
  }
  const {blockType, entityData} = data;
  if (!blockType || !entityData) {
    return null;
  }
  return createEntity(
    blockType,
    'IMMUTABLE',
    entityData,
  );
}

function textToEntity(
  safeHTML: SafeHTML,
  text: string,
  createEntity: Function,
): ?Array<Entity> {
  return [];
}

function htmlToBlock(
  safeHTML: SafeHTML,
  nodeName: string,
  node: Node | ElementLike,
): ?Object {

  const normalizedNode =
    normalizeNodeForTable(safeHTML, nodeName, node);
  if (normalizedNode) {
    node = normalizedNode;
    nodeName = node.nodeName.toLowerCase();
  }
  return htmlToAtomicBlock(safeHTML, nodeName, node);
}

function htmlToAtomicBlock(
  safeHTML: SafeHTML,
  nodeName: string,
  node: Node | ElementLike,
): ?Object {
  if (nodeName !== ATOMIC_ELEMENT_NODE_NAME) {
    return null;
  }
  const element = asElement(node);
  const dataStr = element.getAttribute(DocsDataAttributes.ATOMIC_BLOCK_DATA);
  if (!dataStr) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(dataStr);
  } catch (ex) {
    return null;
  }
  const {blockType, entityData} = data;
  if (!blockType || !entityData) {
    return null;
  }
  return {
    type: 'atomic',
    data: null,
  };
}

function normalizeNodeForTable(
  safeHTML: SafeHTML,
  nodeName: string,
  node: Node | ElementLike,
): ?ElementLike {
  if (nodeName !== 'table') {
    return null;
  }
  const element = asElement(node);
  if (element.hasAttribute(DocsDataAttributes.TABLE)) {
    // Already an docs node
    return null;
  }

  const entityData = createDocsTableEntityDataFromElement(
    safeHTML,
    element,
    convertFromHTML
  );
  const data = {
    blockType: DocsBlockTypes.DOCS_TABLE,
    entityData,
  };
  const atomicNode: any = new FakeAtomicElement(data);
  return atomicNode;
}

export default convertFromHTML;
