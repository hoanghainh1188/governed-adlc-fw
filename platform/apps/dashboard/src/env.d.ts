// Modules Vite provides at build time (vite.config.ts).
declare module 'virtual:dashboard-catalog' {
  /** The `dashboard.*` messages of `@sdlc/messages` (NFR-08). */
  const catalog: Readonly<Record<string, string>>;
  export default catalog;
}

declare module 'virtual:dashboard-admin-catalog' {
  /** U09 (QUESTIONS #686): the `dashboard.admin.*` messages, loaded with the admin screens. */
  const catalog: Readonly<Record<string, string>>;
  export default catalog;
}

declare module '*.css';
