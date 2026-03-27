/**
 * ATmega328/P — subset of port/timer registers (data address space).
 */

export type IoRow = { addr: string; name: string; value: string };

const KNOWN: Array<{ name: string; addr: number }> = [
  { name: "PINB", addr: 0x23 },
  { name: "DDRB", addr: 0x24 },
  { name: "PORTB", addr: 0x25 },
  { name: "PINC", addr: 0x26 },
  { name: "DDRC", addr: 0x27 },
  { name: "PORTC", addr: 0x28 },
  { name: "PIND", addr: 0x29 },
  { name: "DDRD", addr: 0x2a },
  { name: "PORTD", addr: 0x2b },
  { name: "TIFR0", addr: 0x35 },
  { name: "TCCR0A", addr: 0x44 },
  { name: "TCCR0B", addr: 0x45 },
  { name: "TCNT0", addr: 0x46 }
];

export async function readAtmega328IoTable(
  readByte: (addrHex: string) => Promise<string>
): Promise<IoRow[]> {
  const rows: IoRow[] = [];
  for (const k of KNOWN) {
    const hex = `0x${k.addr.toString(16)}`;
    try {
      const v = await readByte(hex);
      rows.push({ addr: hex, name: k.name, value: v || "?" });
    } catch {
      rows.push({ addr: hex, name: k.name, value: "?" });
    }
  }
  return rows;
}
