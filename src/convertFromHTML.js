// @flow

import DocsBlockTypes from './DocsBlockTypes';
import DocsDataAttributes from './DocsDataAttributes';
import DocsDecorator from './DocsDecorator';
import DocsDecoratorTypes from './DocsDecoratorTypes';
import asElement from './asElement';
import convertFromRaw from './convertFromRaw';
import convertToRaw from './convertToRaw';
import getSafeBodyFromHTML from './getSafeBodyFromHTML';
import invariant from 'invariant';
import uniqueID from './uniqueID';
import {ContentState, Modifier, EditorState, Entity} from 'draft-js';
import {convertFromHTML as draftConvertFromHTML} from 'draft-convert';
import {getEntityDataID} from './DocsTableModifiers';
import {toggleHeaderBackground} from './DocsTableModifiers';

import type {DocsTableEntityData,  DocumentLike, ElementLike} from './Types';

type SafeHTML = {
  html: string,
  unsafeNodes: Map<string, Node>,
};

// See https://developer.mozilla.org/en-US/docs/Web/CSS/font-weight
const CSS_BOLD_MIN_NUMERIC_VALUE = 500;
const CSS_BOLD_VALUES = new Set(['bold', 'bolder']);
const CSS_NOT_BOLD_VALUES = new Set(['light', 'lighter', 'normal']);
const CSS_BOLD_MIN_NUMERIC_VALUE_PATTERN = /^\d+$/;

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
  const convertedContentState = draftConvertFromHTML(handlers)(safeHTML.html);
  const currentEditorState = editorState || createEmptyEditorState();
  const newContentState = Modifier.replaceWithFragment(
    currentEditorState.getCurrentContent(),
    currentEditorState.getSelection(),
    convertedContentState.blockMap,
  );
  return EditorState.push(
    currentEditorState,
    newContentState,
    'insert-fragment',
  );
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

function getSafeHTML(
  html: string,
  domDocument?: ?DocumentLike,
): SafeHTML {
  const body = getSafeBodyFromHTML(html, domDocument);
  const unsafeNodes = new Map();
  let safeHTML = '';

  if (body) {
    // The provided chidlren nodes inside the atomic block should never be
    // rendered. Instead, the atomic block should only render with its entity
    // data. Therefore, move the children nodes into the quarantine pool
    // otherwise these chidlren wil be rendered as extra block after the atomic
    // block.
    const quarantine = (node) => {
      const id = uniqueID();
      node.id = id;
      unsafeNodes.set(id, node.cloneNode(true));
      node.innerHTML = ZERO_WIDTH_CHAR;
    };

    const atomicNodes = body.querySelectorAll(
      'figure[' + DocsDataAttributes.ATOMIC_BLOCK_DATA + ']',
    );
    Array.from(atomicNodes).forEach(quarantine);

    const tableNodes = body.querySelectorAll('table');
    Array.from(tableNodes).forEach(quarantine);

    const mathNodes = body.querySelectorAll(
      'span[' +
      DocsDataAttributes.DECORATOR_TYPE + '="' +
      DocsDecoratorTypes.DOCS_MATH +
      '"]',
    );
    Array.from(mathNodes).forEach(quarantine);

    const imgNodes =  body.querySelectorAll('img');
    Array.from(imgNodes).forEach(imageNodeToPlaceholder);
    safeHTML = body.innerHTML;
  }

  return {
    html: safeHTML,
    unsafeNodes,
  };
}

function htmlToStyle(
  safeHTML: SafeHTML,
  nodeName: string,
  node: Node | ElementLike,
  currentStyle: Object,
): Object {
  if (node.nodeType !== NODE_TYPE_ELEMENT) {
    return currentStyle;
  }
  const el = asElement(node);
  let newStyle = currentStyle;
  if (nodeName === 'figure') {
    const {className} = el;
    if (className) {
      const classNames = className.split(/\s+/g);
      newStyle = currentStyle.withMutations((style) => {
        classNames.forEach(className => {
          style.add(className);
        });
      });
    }
  }
  // When content is copied from google doc, its HTML may use a tag
  // like `<b style="font-weight: normal">...</b>` which should not make the
  // text bold. This block handles such case.
  // See related issue: https://github.com/facebook/draft-js/issues/481
  // `el.style` could be `null` if `el` is `<math />`.
  const fontWeight = el.style ? el.style.fontWeight : null;
  if (fontWeight) {
    if (CSS_BOLD_VALUES.has(fontWeight)) {
      newStyle = newStyle.add(STYLE_BOLD);
    } else if (CSS_NOT_BOLD_VALUES.has(fontWeight)) {
      newStyle = newStyle.remove(STYLE_BOLD);
    } else if (CSS_BOLD_MIN_NUMERIC_VALUE_PATTERN.test(fontWeight)) {
      newStyle = parseInt(fontWeight, 10) >= CSS_BOLD_MIN_NUMERIC_VALUE ?
        newStyle.add(STYLE_BOLD) :
        newStyle.remove(STYLE_BOLD);
    }
  }
  return newStyle;
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
    case 'figure':
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

  const entityData = createDocsTableEntityDataFromElement(safeHTML, element);
  const data = {
    blockType: DocsBlockTypes.DOCS_TABLE,
    entityData,
  };
  const atomicNode: any = new FakeAtomicElement(data);
  return atomicNode;
}

function createEmptyEditorState(): EditorState {
  const decorator = DocsDecorator.get();
  const emptyEditorState = EditorState.createEmpty(decorator);
  return emptyEditorState;
}

function createDocsTableEntityDataFromElement(
  safeHTML: SafeHTML,
  table: ElementLike,
): DocsTableEntityData {
  invariant(table.nodeName === 'TABLE', 'must be a table');
  let entityData = {
    rowsCount: 0,
    colsCount: 0,
  };

  // The children of `table` should have been quarantined. We need to access
  // the children from the quarantine pool.
  const el = asElement(safeHTML.unsafeNodes.get(asElement(table).id));

  // TODO: What about having multiple <tbody />, <thead /> and <col />
  // colsSpan, rowsSpan...etc?
  const {rows} = el;

  if (
    !rows ||
    !rows[0] ||
    !rows[0].cells ||
    rows[0].cells.length === 0
  ) {
    return entityData;
  }

  const emptyEditorState = createEmptyEditorState();

  const data: any = entityData;
  const rowsCount = rows ? rows.length : 0;
  const colsCount = Array.from(rows).reduce(
    (max, row) => {
      if (row && row.cells) {
        const len = row.cells.length;
        return len > max ? len : max;
      }
      return max;
    },
    0,
  );

  data.rowsCount = rowsCount;
  data.colsCount = colsCount;
  let rr = 0;
  let useHeader = false;
  while (rr < rowsCount) {
    let cc = 0;
    while (cc < colsCount) {
      // row could be empty, if "rowSpan={n}" is set.
      // cell could be  empty, if "colsSpan={n}" is set.
      let html = '';
      const row = rows[rr];
      if (row) {
        const {cells} = row;
        const cell = cells ? cells[cc] : null;
        if (cell) {
          html = cell.innerHTML;
          if (rr === 0 && cell.nodeName === 'TH') {
            useHeader = true;
          }
        }
      }
      const cellEditorState = convertFromHTML(html, emptyEditorState);
      const id = getEntityDataID(rr, cc);
      data[id] = convertToRaw(cellEditorState);
      cc++;
    }
    rr++;
  }

  if (rowsCount > 1 || useHeader) {
    entityData = toggleHeaderBackground(entityData);
  }

  return entityData;
}

// img does not have characters data, thus DraftJS wo't be able to
// parse its entity data. The workaround is to replace it with an
// empty element that can be converted to DocsImage later.
function imageNodeToPlaceholder(img: Object): void {
  const {parentNode, src} = img;
  if (!parentNode || !src) {
    return;
  }

  if (img.getAttribute(DocsDataAttributes.ELEMENT)) {
    // The image is rendered by <DocsSafeImage /> which contains its meta
    // data at its containing <span /> element. We can skip this <img />
    // element.
    parentNode.removeChild(img);
    return;
  }

  const doc = img.ownerDocument;
  const node = doc.createElement('ins');
  const decoratorData = {
    type: DocsDecoratorTypes.DOCS_IMAGE,
    mutability: 'IMMUTABLE',
    data: {url: src},
  };
  node.setAttribute(
    DocsDataAttributes.DECORATOR_DATA,
    JSON.stringify(decoratorData),
  );
  node.setAttribute(
    DocsDataAttributes.DECORATOR_TYPE,
    DocsDecoratorTypes.DOCS_IMAGE,
  );
  node.innerHTML = ZERO_WIDTH_CHAR;
  parentNode.insertBefore(node, img);
  parentNode.removeChild(img);
}

export default convertFromHTML;
