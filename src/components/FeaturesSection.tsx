import HlsVideo from './HlsVideo'

const HLS_URL =
  'https://stream.mux.com/Jwr2RhmsNrd6GEspBNgm02vJsRZAGlaoQIh4AucGdASw.m3u8'

const cards = [
  {
    title: 'Нейросети',
    desc: 'Все ИИ-сервисы контура Фонда МИК и публичные инструменты в одном месте.',
    stat: '9 сервисов',
    statSub: 'в каталоге',
  },
  {
    title: 'Промпты',
    desc: 'Готовые шаблоны запросов для ежедневных задач — скопируйте, подставьте данные, получите результат.',
    stat: '20+',
    statSub: 'готовых шаблонов',
  },
  {
    title: 'Кейсы',
    desc: 'Пошаговые сценарии, где несколько нейросетей работают вместе для решения одной задачи.',
    stat: 'Реальные',
    statSub: 'рабочие сценарии',
  },
]

export default function FeaturesSection() {
  return (
    <section className="relative py-32 px-4 overflow-hidden">
      {/* Background video */}
      <div className="absolute inset-0">
        <HlsVideo src={HLS_URL} />
      </div>

      {/* Overlays */}
      <div
        className="absolute inset-x-0 top-0 pointer-events-none"
        style={{
          height: '40%',
          background:
            'linear-gradient(to bottom, hsl(var(--background)), hsl(260 87% 3% / 0.8), transparent)',
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 pointer-events-none"
        style={{
          height: '40%',
          background:
            'linear-gradient(to top, hsl(var(--background)), hsl(260 87% 3% / 0.8), transparent)',
        }}
      />
      <div className="absolute inset-0 bg-background/40 pointer-events-none" />

      {/* Content */}
      <div className="relative z-10 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-col items-center text-center mb-16">
          <h2 className="text-hero-heading text-3xl sm:text-5xl font-semibold leading-tight mb-4">
            Инструменты, которые
            <br />
            работают на вас
          </h2>
          <p className="text-muted-foreground text-lg max-w-xl">
            Четыре раздела, которые помогут начать и углубиться в работу с ИИ
          </p>
        </div>

        {/* Cards */}
        <div className="grid md:grid-cols-3 gap-6">
          {cards.map((card) => (
            <div
              key={card.title}
              className="liquid-glass rounded-3xl p-8 hover:bg-white/[0.03] transition-colors"
            >
              <h3 className="text-hero-heading text-xl font-semibold mb-3">
                {card.title}
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {card.desc}
              </p>
              <div className="border-t border-border/50 mt-6 pt-6">
                <p className="text-hero-heading text-2xl font-semibold">
                  {card.stat}
                </p>
                <p className="text-muted-foreground text-sm mt-1">
                  {card.statSub}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
