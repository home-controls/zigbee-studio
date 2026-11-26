// Lets Node run the page's TypeScript modules as they are: the source imports "./format", the
// bundler's way; Node needs the file name, so try ".ts" for relative imports without one.
// (Node strips the types itself; only plain .ts modules, no JSX, are tested this way.)

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      /* not a .ts file: let Node say what's missing */
    }
  }
  return next(specifier, context);
}
