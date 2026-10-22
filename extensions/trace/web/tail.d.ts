/** Типы для тестов: tail.js — браузерный ES-модуль без сборки. */
export declare class SessionTail {
	constructor(fetchFn: (url: string) => Promise<any>);
	file: string;
	offset: number;
	reset(): void;
	poll(): Promise<{ reset: boolean; entries: any[] } | null>;
	feed(buf: Uint8Array): any[];
}
export declare function parseLines(lines: string[]): any[];
