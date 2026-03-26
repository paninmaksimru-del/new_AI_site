const testimonials = [
  {
    text: 'С помощью ИИ-чата я сократил время на написание деловых писем в 3 раза. Теперь трачу 5 минут там, где раньше тратил 15.',
    name: 'Иван Петров',
    role: 'Менеджер по коммуникациям',
    initials: 'ИП',
  },
  {
    text: 'Находить нужные регламенты стало в разы проще. Больше не трачу время на поиск по папкам — ввожу суть и сразу получаю ответ.',
    name: 'Мария Козлова',
    role: 'Аналитик',
    initials: 'МК',
    offset: true,
  },
  {
    text: 'Генерация структуры презентации изменила мой рабочий процесс. Скелет готов за минуты, остаётся только уточнить детали.',
    name: 'Алексей Смирнов',
    role: 'Руководитель проекта',
    initials: 'АС',
  },
]

export default function TestimonialsSection() {
  return (
    <section className="py-32 px-4">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="text-hero-heading text-3xl sm:text-5xl font-semibold leading-tight mb-4">
            Коллеги уже работают
            <br />
            с ИИ каждый день
          </h2>
          <p className="text-muted-foreground text-lg">
            Вот что говорят сотрудники Фонда МИК
          </p>
        </div>

        {/* Cards */}
        <div className="grid md:grid-cols-3 gap-6 items-start">
          {testimonials.map((t) => (
            <div
              key={t.name}
              className={`liquid-glass rounded-3xl p-8 ${t.offset ? 'md:-translate-y-6' : ''}`}
            >
              <p className="text-foreground/80 leading-relaxed mb-6">
                &ldquo;{t.text}&rdquo;
              </p>
              <div className="border-t border-border/50 pt-6 flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-foreground/70 shrink-0">
                  {t.initials}
                </div>
                <div>
                  <p className="text-foreground font-medium text-sm">{t.name}</p>
                  <p className="text-muted-foreground text-xs mt-0.5">{t.role}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
