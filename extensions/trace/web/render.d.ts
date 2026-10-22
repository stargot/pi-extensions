/** Типы для тестов: render.js — браузерный ES-модуль без сборки. */
type Fn = (...args: any[]) => any;

export declare const COLOR: Record<string, string>;
export declare const esc: (s: unknown) => string;
export declare const plural: (n: number, one: string, few: string, many: string) => string;
export declare const turnState: Fn;
export declare const effectiveSel: Fn;
export declare const findTurn: Fn;
export declare const parseFilter: Fn;
export declare const matchTurn: Fn;
export declare const makeScale: Fn;
export declare const toolChips: Fn;
export declare const turnContext: Fn;
export declare const renderStats: Fn;
export declare const renderFlow: Fn;
export declare const renderTimeline: Fn;
export declare const renderContext: Fn;
export declare const renderInspector: Fn;
export declare const renderScrubber: Fn;
