//ALL RIGHTS RESERVED
//Copyright 2025 Chris Singendonk
/**
*
function _a1(b) {
  const defaults = [
    "click", "submit", "change", "keydown", "focus", "blur", "contextmenu",
    "dblclick", "scroll", "input", "mousemove", "mousedown", "mouseup",
    "pointerdown", "pointerup", "pointermove", "wheel", "touchstart",
    "touchmove", "touchend", "paste", "copy", "cut"
  ];
  // Combine defaults and user-provided event names
  // Using a Set ensures no duplicates
  let c = b;
  if (!Array.isArray(b)) { 
   c = ['loaded'];
  }
  const eventNamesSet = new Set([...defaults, ...c]);
    let eventNames = Array.from(eventNamesSet);
  Array.from(Object.keys(window ? window : globalThis ? globalThis : this)).forEach((k) => {
     if (k.startsWith("on"))
     {
       eventNamesSet.add(k.substring(2));
      // Remove the 'on' prefix, e.g. 'onclick' -> 'click'
      const eventName = k.substring(2);
      eventNamesSet.add(eventName);
    }})

  eventNames = Array.from(eventNamesSet);
  return events;
}




/**
* Generic Utility Function
**/
function collectMembers({
  source = (typeof window !== 'undefined'
    ? window
    : (typeof globalThis !== 'undefined' ? globalThis : this)),
  defaults = [],
  extra = [],
  matchers = [
    {
      // e.g. "onclick" => "click"
      type: 'prefix',
      value: 'on',
      transform: (key, prefix) => key.slice(prefix.length),
    },
  ],
} = {}) {
  const resultSet = new Set();

  // Normalize defaults & extra to arrays and seed the set
  const normDefaults = Array.isArray(defaults) ? defaults : [defaults];
  const normExtra = Array.isArray(extra) ? extra : [extra];

  for (const v of normDefaults) {
    if (v != null) resultSet.add(v);
  }
  for (const v of normExtra) {
    if (v != null) resultSet.add(v);
  }

  // If no source, just return what we have
  if (!source) return Array.from(resultSet);

  // Scan keys on the given source
  for (const key of Object.keys(source)) {
    for (const matcher of matchers) {
      const { type, value, transform } = matcher;

      let matched = false;
      switch (type) {
        case 'prefix':
          matched = key.startsWith(value);
          break;
        case 'suffix':
          matched = key.endsWith(value);
          break;
        case 'includes':
          matched = key.includes(value);
          break;
        case 'regex':
          matched = value instanceof RegExp && value.test(key);
          break;
        default:
          // Unknown matcher type – skip
          break;
      }

      if (matched) {
        const transformed = typeof transform === 'function'
          ? transform(key, value)
          : key;

        if (transformed != null && transformed !== '') {
          resultSet.add(transformed);
        }
      }
    }
  }

  return Array.from(resultSet);
}



/**
* Rewrite for Utility Use
**/
function getEventNames(events) {
  const defaults = [
    "click", "submit", "change", "keydown", "focus", "blur", "contextmenu",
    "dblclick", "scroll", "input", "mousemove", "mousedown", "mouseup",
    "pointerdown", "pointerup", "pointermove", "wheel", "touchstart",
    "touchmove", "touchend", "paste", "copy", "cut"
  ];

  const extra = Array.isArray(events) ? events : ['loaded'];

  return collectMembers({
    source: (typeof window !== 'undefined'
      ? window
      : (typeof globalThis !== 'undefined' ? globalThis : this)),
    defaults,
    extra,
    matchers: [
      {
        // scan things like "onclick", "onkeyup", etc.
        type: 'prefix',
        value: 'on',
        transform: (key, prefix) => key.slice(prefix.length),
      }
    ]
  });
}
