import { Button } from './ui/button'
import AnimatedGenerateButton from './ui/animated-generate-button'
import HlsVideo from './HlsVideo'

const HLS_URL =
  'https://stream.mux.com/1CCfG6mPC7LbMOAs6iBOfPeNd3WaKlZuHuKHp00G62j8.m3u8'

const bullets = [
  'Анализ документов и текстов',
  'Создание проектов и задач',
  'Ответы на рабочие вопросы',
]

export default function ChessSection() {
  return (
    <section className="py-32 px-4">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-20 items-center">
        {/* Left — Video */}
        <div className="liquid-glass rounded-3xl aspect-[4/3] overflow-hidden">
          <HlsVideo src={HLS_URL} />
        </div>

        {/* Right — Content */}
        <div>
          <h2 className="text-hero-heading text-3xl sm:text-5xl font-semibold leading-tight mb-6">
            Задавайте вопросы
            <br />
            прямо в чате
          </h2>

          <p className="text-muted-foreground text-lg leading-relaxed mb-8">
            ИИ-чат для рабочих задач. Анализируйте документы, создавайте
            проекты и получайте ответы — всё в одном интерфейсе.
          </p>

          <ul className="space-y-3 mb-10">
            {bullets.map((b) => (
              <li key={b} className="flex items-center gap-3 text-foreground/80">
                <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                {b}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-4 items-center">
            <AnimatedGenerateButton
              href="/chat"
              labelIdle="Открыть чат"
              labelActive="Открываем…"
              highlightHueDeg={121}
              ariaLabel="Открыть чат"
            />
            <Button variant="heroSecondary" asChild>
              <a href="/education">Узнать больше</a>
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
