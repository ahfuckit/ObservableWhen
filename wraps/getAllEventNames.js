//ALL RIGHTS RESERVED
//Copyright 2025 Chris Singendonk

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

  // Now collect any global (window) event handler names
  // E.g. 'onclick', 'onkeyup', etc.
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
