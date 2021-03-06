'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _from = require('babel-runtime/core-js/array/from');

var _from2 = _interopRequireDefault(_from);

var _map = require('babel-runtime/core-js/map');

var _map2 = _interopRequireDefault(_map);

var _DocsDataAttributes = require('./DocsDataAttributes');

var _DocsDataAttributes2 = _interopRequireDefault(_DocsDataAttributes);

var _DocsDecoratorTypes = require('./DocsDecoratorTypes');

var _DocsDecoratorTypes2 = _interopRequireDefault(_DocsDecoratorTypes);

var _asElement = require('./asElement');

var _asElement2 = _interopRequireDefault(_asElement);

var _clearInlineFontStyles = require('./clearInlineFontStyles');

var _clearInlineFontStyles2 = _interopRequireDefault(_clearInlineFontStyles);

var _convertImageElementToPlaceholderElement = require('./convertImageElementToPlaceholderElement');

var _convertImageElementToPlaceholderElement2 = _interopRequireDefault(_convertImageElementToPlaceholderElement);

var _getCSSRules = require('./getCSSRules');

var _getCSSRules2 = _interopRequireDefault(_getCSSRules);

var _getSafeDocumentElementFromHTML = require('./getSafeDocumentElementFromHTML');

var _getSafeDocumentElementFromHTML2 = _interopRequireDefault(_getSafeDocumentElementFromHTML);

var _mergeCSSRuleStylesToElement = require('./mergeCSSRuleStylesToElement');

var _mergeCSSRuleStylesToElement2 = _interopRequireDefault(_mergeCSSRuleStylesToElement);

var _uniqueID = require('./uniqueID');

var _uniqueID2 = _interopRequireDefault(_uniqueID);

var _DocsCharacter = require('./DocsCharacter');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var babelPluginFlowReactPropTypes_proptype_DocumentLike = require('./Types').babelPluginFlowReactPropTypes_proptype_DocumentLike || require('prop-types').any;

var babelPluginFlowReactPropTypes_proptype_CSSRules = require('./getCSSRules').babelPluginFlowReactPropTypes_proptype_CSSRules || require('prop-types').any;

if (typeof exports !== 'undefined') Object.defineProperty(exports, 'babelPluginFlowReactPropTypes_proptype_SafeHTML', {
  value: require('prop-types').shape({
    html: require('prop-types').string.isRequired,
    unsafeNodes: require('prop-types').any.isRequired,
    cssRules: babelPluginFlowReactPropTypes_proptype_CSSRules
  })
});


var DEPTH_CLASS_NAME_PATTERN = /(public-DraftStyleDefault-depth)(\d+)/;

function getSafeHTML(html, domDocument, defaultCSSRules) {
  // This forces an extra space between consecutive <span />, which naively
  // fixes the problem of missing spacing between inline elements.
  html = html.replace(/<\/span><span/g, '</span> <span');

  var documentElement = (0, _getSafeDocumentElementFromHTML2.default)(html, domDocument);
  var body = documentElement ? documentElement.querySelector('body') : null;
  var ownerDocument = body && body.ownerDocument;
  var cssRules = defaultCSSRules || (0, _getCSSRules2.default)(ownerDocument);
  var unsafeNodes = new _map2.default();
  var safeHTML = '';
  if (body) {
    // The provided chidlren nodes inside the atomic block should never be
    // rendered. Instead, the atomic block should only render with its entity
    // data. Therefore, move the children nodes into the quarantine pool
    // otherwise these chidlren wil be rendered as extra block after the atomic
    // block.
    var quarantine = function quarantine(node) {
      var id = (0, _uniqueID2.default)();
      node.id = id;
      unsafeNodes.set(id, node.cloneNode(true));
      node.setAttribute('data-quarantined-by-safe-html', id);
      node.innerHTML = _DocsCharacter.CHAR_ZERO_WIDTH;
    };

    var atomicNodes = body.querySelectorAll('figure[' + _DocsDataAttributes2.default.ATOMIC_BLOCK_DATA + ']');
    (0, _from2.default)(atomicNodes).forEach(quarantine);

    // Apply all linked CSS styles to element.
    (0, _from2.default)(body.querySelectorAll('[class]')).forEach(_mergeCSSRuleStylesToElement2.default.bind(null, cssRules));

    var tableNodes = body.querySelectorAll('table');
    (0, _from2.default)(tableNodes).forEach(quarantine);

    var mathNodes = body.querySelectorAll('span[' + _DocsDataAttributes2.default.DECORATOR_TYPE + '="' + _DocsDecoratorTypes2.default.DOCS_MATH + '"]');
    (0, _from2.default)(mathNodes).forEach(quarantine);

    var imgNodes = body.querySelectorAll('img');
    (0, _from2.default)(imgNodes).forEach(_convertImageElementToPlaceholderElement2.default);

    // Monkey patch potentially nested lists.
    var listNodes = body.querySelectorAll('ul, ol');
    (0, _from2.default)(listNodes).forEach(monkeyPatchListElementDepth);

    // Clear all font size inside headers.
    var headings = body.querySelectorAll('h1, h2, h3, h5, h6');
    (0, _from2.default)(headings).forEach(_clearInlineFontStyles2.default);

    safeHTML = body.innerHTML;
  }

  return {
    cssRules: cssRules,
    html: safeHTML,
    unsafeNodes: unsafeNodes
  };
}

function monkeyPatchListElementDepth(el) {
  var listNodeName = el.nodeName;
  if (listNodeName !== 'UL' && listNodeName !== 'OL') {
    return;
  }

  (0, _from2.default)(el.children).forEach(function (item) {
    var nodeName = item.nodeName,
        parentElement = item.parentElement,
        style = item.style,
        className = item.className;

    if (nodeName !== 'LI') {
      return;
    }

    var depth = 0;

    var marginLeft = style.marginLeft;

    if (marginLeft && marginLeft.indexOf('pt') > 0) {
      // This is just a workaround to deal with HTML generated by google doc.
      // Somehow in google doc, nested OL or UL elements may not be nested.
      // Instead, the nested UI / OL will noyt be nested and rendered with
      // margin-left. This function is to enforce the nested structure that can
      // be correctly parsed by draft-convert.
      var marginLeftPoints = Math.round(parseFloat(style.marginLeft));
      depth = Math.round(marginLeftPoints / 36);
    } else if (className) {
      var mm = className.match(DEPTH_CLASS_NAME_PATTERN);
      depth = mm && mm[2] ? parseInt(mm[2], 10) : 0;
    }

    if (!depth) {
      return;
    }
    var doc = item.ownerDocument;

    var currentEl = item;
    while (depth > 0) {
      var parentEl = el.cloneNode(false);
      parentEl.appendChild(currentEl);
      currentEl = parentEl;
      depth--;
    }
    if (currentEl !== item) {
      el.appendChild(currentEl);
    }
  });
}

exports.default = getSafeHTML;