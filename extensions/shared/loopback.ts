/**
 * Общий loopback-гард для локальных веб-серверов расширений.
 *
 * Host указывает на loopback. Защита от DNS rebinding: чужой домен,
 * перерезолвленный в 127.0.0.1, приходит со своим Host — и тогда сверка
 * Origin с Host ничего не ловит, а локальные эндпоинты читаются кросс-доменно.
 *
 * Вынесено из trace/web/serve.ts (0.3.x); единственный потребитель —
 * session-trace (quiz раньше переиспользовал гард, но веб-режим у него выведен).
 */
export function isLoopbackHost(host: string | undefined): boolean {
	if (!host) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}
