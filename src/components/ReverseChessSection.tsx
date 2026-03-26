import { Button } from './ui/button'
import HlsVideo from './HlsVideo'

const HLS_URL =
  'https://stream.mux.com/f0001qPDy00mvqP023lqK3lWx31uHvxirFCHK1yNLczzqxY.m3u8'

const stats = [
  { value: '9', label: 'ИИ-инструментов' },
  { value: '3', label: 'уровня обучения' },
  { value: '20+', label: 'промптов' },
  { value: '4', label: 'раздела' },
]

export default function ReverseChessSection() {
  return (
    <section className="py-32 px-4">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-20 items-center">
        {/* Left — Content */}
        <div className="order-2 lg:order-1">
          <h2 className="text-hero-heading text-3xl sm:text-5xl font-semibold leading-tight mb-6">
            Найдите нужное
            <br />
            по смыслу
          </h2>

          <p className="text-muted-foreground text-lg leading-relaxed mb-8">
            Семантический поиск по документам и регламентам. Находите нужные
            материалы по смыслу, а не по точному названию файла.
          </p>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-4 mb-10">
            {stats.map((s) => (
              <div
                key={s.label}
                className="liquid-glass rounded-2xl p-4"
              >
                <p className="text-hero-heading text-2xl font-semibold">
                  {s.value}
                </p>
                <p className="text-muted-foreground text-sm mt-1">{s.label}</p>
              </div>
            ))}
          </div>

          <Button variant="hero" asChild>
            <a href="/education">Перейти к материалам</a>
          </Button>
        </div>

        {/* Right — Video */}
        <div className="order-1 lg:order-2 liquid-glass rounded-3xl aspect-[4/3] overflow-hidden">
          <HlsVideo src={HLS_URL} />
        </div>
      </div>
    </section>
  )
}
