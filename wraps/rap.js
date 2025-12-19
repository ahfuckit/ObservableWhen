// ALL RIGHTS RESERVED
// © 2024, 2025, 2026 - Chris Singendonk  


const log = function (...data) {
  console.log(data);
};

const error = function (...data) {
  console.error(...data);
};
const wrap = function ()  {
  const ALW = function (target = Object.create(this), wrapper = null) {
    if (!target || wrapper) {
      (Object.assign({}, window.console)).log(' ? ');
    };
    if (wrapper == Object.create(this) || wrapper == null) {
      wrapper = undefined;
    }
    const wrapperObj = wrapper ? wrapper : {};
    if (target == wrapper) {
      let v = Object.assign({}, wrapper,target,{invalid: wrapper, nonsubstantial: target})
      return true;
    }
    try {
      const theTarget = Object.assign({}, {...target});
      Array.from(Object.keys(theTarget)).forEach((prop) => {
        if (typeof target[prop] === "function") {
          try {
            const original = target[prop].bind(theTarget);
            window[target.name ? target.name : 'console'][prop] = (...args) => {
              return original(...args);
            };
          } catch (e) {
            
          }
        }
      });
  
      // Wrap methods from the prototype chain (for objects like document)
      let proto = Object.getPrototypeOf(target);
      while (proto) {
        Object.getOwnPropertyNames(proto).forEach((method) => {
          // Skip the constructor and if it's already wrapped
          if (method === "constructor" || wrapperObj[method]) return;
          const descriptor = Object.getOwnPropertyDescriptor(proto, method);
          if (descriptor && typeof descriptor.value === "function") {
            
            const original = descriptor.value;
            try {
              wrapperObj[method] = (...args) => {
                log(target.constructor.name, method, args);
                return original.apply(target, args);
              };
            } catch (e) {
              (Object.assign({}, window.console)).error(`Error wrapping ${method}:`, e);
            }
          }
        });
        proto = Object.getPrototypeOf(proto);
      }
    } catch (error) {
      (Object.assign({}, window.console)).error(error);
    }
  };
  
  function rap(hip) {
    if (JSON.stringify(hip) || JSON.parse(hip)) {
      
    }
  const wrappedConsole = {};
  ALW(hip, wrappedConsole);
  Object.assign(hip, {...wrappedConsole})
  window.console.log("Hello, world!");
  console.error('noerror');
    return wrappedConsole;
  }
  return rap;
  }
  wrap();
