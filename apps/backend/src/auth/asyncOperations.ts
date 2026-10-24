export type AsyncOperations<T> = {
  [K in keyof T as T[K] extends (...args:any[]) => any ? K : never]:
    T[K] extends (...args:infer A) => infer R ? (...args:A) => Promise<Awaited<R>> : never;
};

/** Preserve receiver binding and forward both synchronous and asynchronous failures. */
export function asyncOperations<T extends object>(load:() => T | AsyncOperations<T> | Promise<T | AsyncOperations<T>>):AsyncOperations<T> {
  return new Proxy({} as AsyncOperations<T>, {
    get(_target, method) {
      return async (...args:unknown[]) => {
        const service=await load();
        const operation=Reflect.get(service,method);
        if(typeof operation !== "function") throw new Error("Unknown account operation");
        return operation.apply(service,args);
      };
    },
  });
}
