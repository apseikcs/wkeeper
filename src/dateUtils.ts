const MOSCOW_OFFSET_HOURS = 3

function partsFor(date: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).formatToParts(date)
	const map: Record<string,string> = {}
	parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value })
	return map
}

export function startOfDay(date: Date): Date {
	const p = partsFor(date, 'Europe/Moscow', { year: 'numeric', month: '2-digit', day: '2-digit' })
	const y = Number(p.year), m = Number(p.month) - 1, d = Number(p.day)
	return new Date(Date.UTC(y, m, d, 0 - MOSCOW_OFFSET_HOURS, 0, 0, 0))
}

export function endOfDay(date: Date): Date {
	const p = partsFor(date, 'Europe/Moscow', { year: 'numeric', month: '2-digit', day: '2-digit' })
	const y = Number(p.year), m = Number(p.month) - 1, d = Number(p.day)
	return new Date(Date.UTC(y, m, d, 23 - MOSCOW_OFFSET_HOURS, 59, 59, 999))
}

export function formatDate(date: Date | string | number): string {
	const d = new Date(date)
	const p = partsFor(d, 'Europe/Moscow', {
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hour12: false
	})
	return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`
}

export function nowInMoscow(): Date {
	return new Date()
}