/**
 * Training-only questions the generator does not produce: other phrasings for sources and plain replies, and cities
 * named the way Russian and German speakers write them (inflected exonyms). None of these cities or phrasings is in
 * the benchmark's hard cases (Рим, Варшава, Краков, Флоренция, Бухарест, Вена, Париж; Norcia, Assisi, Perugia,
 * Spoleto, Foligno), so the benchmark still measures how well the router generalizes to them.
 */
export const EXTRA_SOURCES: Record<"ru" | "en" | "de", string[]> = {
  ru: ["Откуда данные?", "Какие у тебя есть данные?", "Чьи это данные о местах?", "Какие наборы данных загружены?", "Какая лицензия у данных OpenStreetMap?", "Что за источник INGV?", "Покажи список источников", "Какие каталоги землетрясений используются?", "Насколько свежие данные?", "Откуда ты берёшь места?"],
  en: ["What data do you have?", "Which datasets are loaded?", "Who provides the place data?", "What is the licence of the OpenStreetMap data?", "Tell me about the INGV source", "List the sources", "Which earthquake catalogues do you use?", "How fresh is the data?", "Where do the places come from?", "Is the USGS catalogue included?"],
  de: ["Welche Daten hast du?", "Welche Datensätze sind geladen?", "Wer liefert die Ortsdaten?", "Welche Lizenz haben die OpenStreetMap-Daten?", "Was ist die Quelle INGV?", "Zeig die Quellen", "Welche Erdbebenkataloge nutzt du?", "Wie aktuell sind die Daten?", "Woher kommen die Orte?", "Ist der USGS-Katalog dabei?"],
};

export const EXTRA_REPLIES: Record<"ru" | "en" | "de", string[]> = {
  ru: ["Здравствуй", "Добрый день!", "Как дела?", "Чем можешь помочь?", "Благодарю!", "Пока", "Какая погода будет завтра?", "Закажи мне такси", "Переведи слово hello", "Расскажи анекдот", "Ок, понятно", "Сколько будет 2+2?"],
  en: ["Hi there", "Good morning!", "How are you?", "How can you help me?", "Thank you so much!", "Bye", "What's the weather tomorrow?", "Order me a taxi", "Translate hello into French", "Tell me a joke", "Ok, got it", "What is 2+2?"],
  de: ["Hi!", "Guten Morgen!", "Wie geht's?", "Wobei kannst du helfen?", "Vielen Dank!", "Tschüss", "Wie wird das Wetter morgen?", "Bestell mir ein Taxi", "Übersetze hello ins Französische", "Erzähl einen Witz", "Ok, verstanden", "Was ist 2+2?"],
};

/** Local name, Russian prepositional ("в …") and genitive ("у …"), and German exonym. */
export const EXONYMS: Array<{ local: string; ruIn: string; ruNear: string; de: string; events?: boolean }> = [
  { local: "Milano", ruIn: "Милане", ruNear: "Милана", de: "Mailand" },
  { local: "Napoli", ruIn: "Неаполе", ruNear: "Неаполя", de: "Neapel" },
  { local: "Venezia", ruIn: "Венеции", ruNear: "Венеции", de: "Venedig" },
  { local: "Torino", ruIn: "Турине", ruNear: "Турина", de: "Turin" },
  { local: "Genova", ruIn: "Генуе", ruNear: "Генуи", de: "Genua" },
  { local: "München", ruIn: "Мюнхене", ruNear: "Мюнхена", de: "München" },
  { local: "Praha", ruIn: "Праге", ruNear: "Праги", de: "Prag" },
  { local: "Lisboa", ruIn: "Лиссабоне", ruNear: "Лиссабона", de: "Lissabon" },
  { local: "Gdańsk", ruIn: "Гданьске", ruNear: "Гданьска", de: "Danzig" },
  { local: "Wrocław", ruIn: "Вроцлаве", ruNear: "Вроцлава", de: "Breslau" },
  { local: "Poznań", ruIn: "Познани", ruNear: "Познани", de: "Posen" },
  { local: "Cluj-Napoca", ruIn: "Клуже", ruNear: "Клужа", de: "Klausenburg" },
  { local: "Brașov", ruIn: "Брашове", ruNear: "Брашова", de: "Kronstadt" },
  { local: "Timișoara", ruIn: "Тимишоаре", ruNear: "Тимишоары", de: "Temeswar" },
  { local: "Iași", ruIn: "Яссах", ruNear: "Ясс", de: "Jassy" },
  { local: "Sevilla", ruIn: "Севилье", ruNear: "Севильи", de: "Sevilla" },
  { local: "Ancona", ruIn: "Анконе", ruNear: "Анконы", de: "Ancona", events: true },
  { local: "Siena", ruIn: "Сиене", ruNear: "Сиены", de: "Siena", events: true },
  { local: "Pisa", ruIn: "Пизе", ruNear: "Пизы", de: "Pisa", events: true },
  { local: "Macerata", ruIn: "Мачерате", ruNear: "Мачераты", de: "Macerata", events: true },
  { local: "Arezzo", ruIn: "Ареццо", ruNear: "Ареццо", de: "Arezzo", events: true },
  { local: "Terni", ruIn: "Терни", ruNear: "Терни", de: "Terni", events: true },
];
