import { ATTR_KEY } from "../constants"
import { isSameNodeType, isNamedNode } from "./index"
import { createNode, setAccessor } from "../dom/index"
import { npn, isArray } from "../util"
import { removeNode } from "../dom/index"

/** Queue of components that have been mounted and are awaiting componentDidMount */
export const mounts = []

/** Diff recursion count, used to track the end of the diff cycle. */
export let diffLevel = 0

/** Global flag indicating if the diff is currently within an SVG */
let isSvgMode = false

/** Global flag indicating if the diff is performing hydration */
let hydrating = false

/** Apply differences in a given vnode (and it's deep children) to a real DOM Node.
 *	@param {Element} [dom=null]		A DOM node to mutate into the shape of the `vnode`
 *	@param {VNode} vnode			A VNode (with descendants forming a tree) representing the desired DOM structure
 *	@returns {Element} dom			The created/mutated element
 *	@private
 */
export function diff(dom, vnode, context, mountAll, parent, componentRoot) {
  // diffLevel having been 0 here indicates initial entry into the diff (not a subdiff)
  let ret
  if (!diffLevel++) {
    // when first starting the diff, check if we're diffing an SVG or within an SVG
    isSvgMode = parent != null && parent.ownerSVGElement !== undefined

    // hydration is indicated by the existing element to be diffed not having a prop cache
    hydrating = dom != null && !(ATTR_KEY in dom)
  }
  if (isArray(vnode)) {
    ret = []
    let parentNode = null
    if (isArray(dom)) {
      parentNode = dom[0].parentNode
      dom.forEach(function (item, index) {
        ret.push(
          idiff(item, vnode[index], context, mountAll, componentRoot)
        )
      })
    } else {
      vnode.forEach(function (item) {
        ret.push(
          idiff(dom, item, context, mountAll, componentRoot)
        )
      })
    };
    if (parent) {
      ret.forEach(function (vnode) {
        parent.appendChild(vnode)
      })
    } else if (isArray(dom)) {
      dom.forEach(function (node) {
        parentNode.appendChild(node)
      })
    }
  } else {
    ret = idiff(dom, vnode, context, mountAll, componentRoot)
    // append the element if its a new parent
    if (parent && ret.parentNode !== parent) parent.appendChild(ret)
  }


  // diffLevel being reduced to 0 means we're exiting the diff
  if (!--diffLevel) {
    hydrating = false
    // invoke queued componentDidMount lifecycle methods
  }

  return ret
}

/** Internals of `diff()`, separated to allow bypassing diffLevel / mount flushing. */
function idiff(dom, vnode, context, mountAll, componentRoot) {
  if (dom && dom.props) {
    dom.props.children = vnode.children
  }
  let out = dom,
    prevSvgMode = isSvgMode

  // empty values (null, undefined, booleans) render as empty Text nodes
  if (vnode == null || typeof vnode === "boolean") vnode = ""

  // Fast case: Strings & Numbers create/update Text nodes.
  if (typeof vnode === "string" || typeof vnode === "number") {
    // update if it's already a Text node:
    if (
      dom &&
			dom.splitText !== undefined &&
			dom.parentNode &&
			(!dom._component || componentRoot)
    ) {
      /* istanbul ignore if */ /* Browser quirk that can't be covered: https://github.com/developit/preact/commit/fd4f21f5c45dfd75151bd27b4c217d8003aa5eb9 */
      if (dom.nodeValue != vnode) {
        dom.nodeValue = vnode
      }
    } else {
      // it wasn't a Text node: replace it with one and recycle the old Element
      out = document.createTextNode(vnode)
      if (dom) {
        if (dom.parentNode) dom.parentNode.replaceChild(out, dom)
        recollectNodeTree(dom, true)
      }
    }

    out[ATTR_KEY] = true

    return out
  }

  // If the VNode represents a Component, perform a component diff:
  let vnodeName = vnode.nodeName

  // Tracks entering and exiting SVG namespace when descending through the tree.
  isSvgMode =
		vnodeName === "svg"
		  ? true
		  : vnodeName === "foreignObject"
		    ? false
		    : isSvgMode

  // If there's no existing element or it's the wrong type, create a new one:
  vnodeName = String(vnodeName)
  if (!dom || !isNamedNode(dom, vnodeName)) {
    out = createNode(vnodeName, isSvgMode)

    if (dom) {
      // move children into the replacement node
      while (dom.firstChild) out.appendChild(dom.firstChild)

      // if the previous Element was mounted into the DOM, replace it inline
      if (dom.parentNode) dom.parentNode.replaceChild(out, dom)

      // recycle the old element (skips non-Element node types)
      recollectNodeTree(dom, true)
    }
  }

  let fc = out.firstChild,
    props = out[ATTR_KEY],
    vchildren = vnode.children

  if (props == null) {
    props = out[ATTR_KEY] = {}
    for (let a = out.attributes, i = a.length; i--; )
      props[a[i].name] = a[i].value
  }

  // Optimization: fast-path for elements containing a single TextNode:
  if (
    !hydrating &&
		vchildren &&
		vchildren.length === 1 &&
		typeof vchildren[0] === "string" &&
		fc != null &&
		fc.splitText !== undefined &&
		fc.nextSibling == null
  ) {
    if (fc.nodeValue != vchildren[0]) {
      fc.nodeValue = vchildren[0]
    }
  }
  // otherwise, if there are existing or new children, diff them:
  else if ((vchildren && vchildren.length) || fc != null) {
    innerDiffNode(
      out,
      vchildren,
      context,
      mountAll,
      hydrating || props.dangerouslySetInnerHTML != null
    )
  }

  // Apply attributes/props from VNode to the DOM Element:
  diffAttributes(out, vnode.attributes, props)
  if (out.props) {
    out.props.children = vnode.children
  }
  // restore previous SVG mode: (in case we're exiting an SVG namespace)
  isSvgMode = prevSvgMode

  return out
}

/** Apply child and attribute changes between a VNode and a DOM Node to the DOM.
 *	@param {Element} dom			Element whose children should be compared & mutated
 *	@param {Array} vchildren		Array of VNodes to compare to `dom.childNodes`
 *	@param {Object} context			Implicitly descendant context object (from most recent `getChildContext()`)
 *	@param {Boolean} mountAll
 *	@param {Boolean} isHydrating	If `true`, consumes externally created elements similar to hydration
 */
function innerDiffNode(dom, vchildren, context, mountAll, isHydrating) {
  let originalChildren = dom.childNodes,
    children = [],
    keyed = {},
    keyedLen = 0,
    min = 0,
    len = originalChildren.length,
    childrenLen = 0,
    vlen = vchildren ? vchildren.length : 0,
    j,
    c,
    f,
    vchild,
    child

  // Build up a map of keyed children and an Array of unkeyed children:
  if (len !== 0) {
    for (let i = 0; i < len; i++) {
      let child = originalChildren[i],
        props = child[ATTR_KEY],
        key =
					vlen && props
					  ? child._component
					    ? child._component.__key
					    : props.key
					  : null
      if (key != null) {
        keyedLen++
        keyed[key] = child
      } else if (
        props ||
				(child.splitText !== undefined
				  ? isHydrating
				    ? child.nodeValue.trim()
				    : true
				  : isHydrating)
      ) {
        children[childrenLen++] = child
      }
    }
  }

  if (vlen !== 0) {
    for (let i = 0; i < vlen; i++) {
      vchild = vchildren[i]
      child = null

      // attempt to find a node based on key matching
      let key = vchild.key
      if (key != null) {
        if (keyedLen && keyed[key] !== undefined) {
          child = keyed[key]
          keyed[key] = undefined
          keyedLen--
        }
      }
      // attempt to pluck a node of the same type from the existing children
      else if (!child && min < childrenLen) {
        for (j = min; j < childrenLen; j++) {
          if (
            children[j] !== undefined &&
						isSameNodeType((c = children[j]), vchild, isHydrating)
          ) {
            child = c
            children[j] = undefined
            if (j === childrenLen - 1) childrenLen--
            if (j === min) min++
            break
          }
        }
      }

      // morph the matched/found/created DOM child to match vchild (deep)
      child = idiff(child, vchild, context, mountAll)

      f = originalChildren[i]
      if (child && child !== dom && child !== f) {
        if (f == null) {
          dom.appendChild(child)
        } else if (child === f.nextSibling) {
          removeNode(f)
        } else {
          dom.insertBefore(child, f)
        }
      }
    }
  }

  // remove unused keyed children:
  if (keyedLen) {
    for (let i in keyed)
      if (keyed[i] !== undefined) recollectNodeTree(keyed[i], false)
  }

  // remove orphaned unkeyed children:
  while (min <= childrenLen) {
    if ((child = children[childrenLen--]) !== undefined)
      recollectNodeTree(child, false)
  }
}

/** Recursively recycle (or just unmount) a node and its descendants.
 *	@param {Node} node						DOM node to start unmount/removal from
 *	@param {Boolean} [unmountOnly=false]	If `true`, only triggers unmount lifecycle, skips removal
 */
export function recollectNodeTree(node, unmountOnly) {
  // If the node's VNode had a ref function, invoke it with null here.
  // (this is part of the React spec, and smart for unsetting references)
  if (node[ATTR_KEY] != null && node[ATTR_KEY].ref) node[ATTR_KEY].ref(null)

  if (unmountOnly === false || node[ATTR_KEY] == null) {
    removeNode(node)
  }

  removeChildren(node)
}

/** Recollect/unmount all children.
 *	- we use .lastChild here because it causes less reflow than .firstChild
 *	- it's also cheaper than accessing the .childNodes Live NodeList
 */
export function removeChildren(node) {
  node = node.lastChild
  while (node) {
    let next = node.previousSibling
    recollectNodeTree(node, true)
    node = next
  }
}

/** Apply differences in attributes from a VNode to the given DOM Element.
 *	@param {Element} dom		Element with attributes to diff `attrs` against
 *	@param {Object} attrs		The desired end-state key-value attribute pairs
 *	@param {Object} old			Current/previous attributes (from previous VNode or element's prop cache)
 */
function diffAttributes(dom, attrs, old) {
  let name
  let update = false
  let isWeElement = dom.update
  // remove attributes no longer present on the vnode by setting them to undefined
  for (name in old) {
    if (!(attrs && attrs[name] != null) && old[name] != null) {
      setAccessor(dom, name, old[name], (old[name] = undefined), isSvgMode)
      if (isWeElement) {
        delete dom.props[name]
        update = true
      }
    }
  }

  // add new & update changed attributes
  for (name in attrs) {
    //diable when using store system?
    //!dom.store &&
    if (isWeElement && typeof attrs[name] === "object") {
      dom.props[npn(name)] = attrs[name]
      update = true
    } else if (
      name !== "children" &&
			name !== "innerHTML" &&
			(!(name in old) ||
				attrs[name] !==
					(name === "value" || name === "checked" ? dom[name] : old[name]))
    ) {
      setAccessor(dom, name, old[name], (old[name] = attrs[name]), isSvgMode)
      if (isWeElement) {
        dom.props[npn(name)] = attrs[name]
        update = true
      }
    }
  }

  dom.parentNode && update && isWeElement && dom.update()
}
