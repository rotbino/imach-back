/**
 * Reference-goods dataset — wave 1 (part B: textile → medical + hidden services).
 * Same contract as catalog-goods-a.ts.
 */

import type { GoodSeed } from "./catalog-goods-a";

export const GOODS_B: Record<string, GoodSeed[]> = {
  // ── textile ───────────────────────────────────────────────────────────
  fabrics: [
    { n: "پارچه نخی", e: "Cotton fabric", a: ["نخی"] },
    { n: "پارچه پلی‌استر", e: "Polyester fabric" },
    { n: "پارچه ترگال", e: "Tergal fabric" },
    { n: "پارچه دنیم", e: "Denim fabric", a: ["جین"] },
    { n: "پارچه فاستونی", e: "Worsted fabric" },
    { n: "پارچه حوله‌ای", e: "Terry fabric" },
    { n: "پارچه موکت", e: "Carpet-tile fabric" },
  ],
  yarn: [
    { n: "نخ پلی‌استر", e: "Polyester yarn", a: ["نخ"] },
    { n: "نخ پنبه", e: "Cotton yarn" },
    { n: "الیاف پلی‌استر", e: "Polyester fibers" },
    { n: "الیاف ضایعاتی", e: "Recycled fibers" },
  ],
  garments: [
    { n: "تیشرت", e: "T-shirt" },
    { n: "شلوار جین", e: "Jeans" },
    { n: "شلوار پارچه‌ای", e: "Fabric trousers" },
    { n: "پیراهن مردانه", e: "Men's shirt" },
    { n: "مانتو", e: "Mantle coat" },
    { n: "جوراب", e: "Socks" },
    { n: "لباس بچگانه", e: "Kids clothing" },
    { n: "پوشاک کارگری", e: "Workwear" },
  ],
  "carpets-rugs": [
    { n: "فرش ماشینی", e: "Machine-made carpet", a: ["فرش"] },
    { n: "فرش دستباف تبریز", e: "Tabriz handmade carpet" },
    { n: "فرش دستباف کاشان", e: "Kashan handmade carpet" },
    { n: "گلیم", e: "Kilim" },
    { n: "پتو", e: "Blanket" },
    { n: "روتختی", e: "Bedspread" },
    { n: "پرده", e: "Curtain" },
    { n: "حوله", e: "Towel" },
  ],

  // ── footwear ──────────────────────────────────────────────────────────
  shoes: [
    { n: "کفش چرم مردانه", e: "Men's leather shoes", a: ["کفش"] },
    { n: "کفش اسپرت", e: "Sports shoes" },
    { n: "کفش زنانه", e: "Women's shoes" },
    { n: "کفش بچگانه", e: "Kids shoes" },
    { n: "دمپایی", e: "Slippers" },
  ],
  "bags-leather": [
    { n: "کیف چرم مردانه", e: "Men's leather bag", a: ["کیف"] },
    { n: "کیف دستی زنانه", e: "Women's handbag" },
    { n: "چمدان", e: "Suitcase" },
    { n: "کوله پشتی", e: "Backpack" },
    { n: "چرم گاوی", e: "Cowhide leather", a: ["چرم"] },
    { n: "چرم بزی", e: "Goat leather" },
  ],

  // ── home-appliances ───────────────────────────────────────────────────
  "major-appliances": [
    { n: "یخچال‌فریزر", e: "Refrigerator-freezer", a: ["یخچال"] },
    { n: "ماشین لباسشویی", e: "Washing machine" },
    { n: "ماشین ظرفشویی", e: "Dishwasher" },
    { n: "جاروبرقی", e: "Vacuum cleaner" },
    { n: "کولر گازی", e: "Air conditioner" },
    { n: "اجاق گاز", e: "Gas stove" },
    { n: "فریزر افقی", e: "Chest freezer" },
  ],
  "kitchen-electric": [
    { n: "چای‌ساز", e: "Tea maker" },
    { n: "سرخ‌کن", e: "Deep fryer" },
    { n: "غذاساز", e: "Food processor" },
    { n: "مخلوط‌کن", e: "Blender" },
    { n: "آبمیوه‌گیری", e: "Juicer" },
    { n: "ساندویچ‌ساز", e: "Sandwich maker" },
    { n: "کتری برقی", e: "Electric kettle" },
  ],
  cookware: [
    { n: "سرویس قابلمه", e: "Cookware set", a: ["قابلمه"] },
    { n: "سرویس پخت‌وپز استیل", e: "Steel cookware set" },
    { n: "ظروف چینی", e: "Porcelain tableware" },
    { n: "سماور برقی", e: "Electric samovar" },
    { n: "سرویس پذیرایی", e: "Serving set" },
  ],

  // ── digital ───────────────────────────────────────────────────────────
  "mobile-accessories": [
    { n: "گوشی موبایل", e: "Mobile phone", a: ["موبایل", "گوشی"] },
    { n: "تبلت", e: "Tablet" },
    { n: "هندزفری", e: "Headphones" },
    { n: "پاوربانک", e: "Power bank" },
    { n: "شارژر", e: "Charger" },
    { n: "کابل شارژ", e: "Charging cable" },
    { n: "قاب گوشی", e: "Phone case" },
    { n: "گلس گوشی", e: "Screen protector", a: ["گلس"] },
  ],
  "computer-network": [
    { n: "لپ‌تاپ", e: "Laptop" },
    { n: "مانیتور", e: "Monitor" },
    { n: "پرینتر", e: "Printer" },
    { n: "کیس کامپیوتر", e: "PC case" },
    { n: "مودم روتر", e: "Modem router" },
    { n: "سوئیچ شبکه", e: "Network switch" },
    { n: "کیبورد و ماوس", e: "Keyboard & mouse" },
    { n: "دوربین مداربسته", e: "CCTV camera" },
  ],
  storage: [
    { n: "فلش مموری", e: "USB flash drive" },
    { n: "هارد اکسترنال", e: "External hard drive" },
    { n: "SSD", e: "SSD drive" },
    { n: "کارت حافظه", e: "Memory card" },
  ],

  // ── furniture ─────────────────────────────────────────────────────────
  "home-furniture": [
    { n: "مبل راحتی", e: "Sofa set", a: ["مبل"] },
    { n: "مبل استیل", e: "Classic sofa" },
    { n: "تخت خواب", e: "Bed" },
    { n: "کمد", e: "Wardrobe" },
    { n: "میز ناهارخوری", e: "Dining table" },
  ],
  "office-furniture": [
    { n: "صندلی اداری", e: "Office chair" },
    { n: "میز کار", e: "Work desk" },
    { n: "میز جلسات", e: "Meeting table" },
    { n: "پارتیشن اداری", e: "Office partition" },
    { n: "کمد فایل", e: "Filing cabinet" },
  ],
  decor: [
    { n: "پرده", e: "Curtain" },
    { n: "آباژور", e: "Table lamp" },
    { n: "ساعت دیواری", e: "Wall clock" },
    { n: "تابلو نقاشی", e: "Painting" },
    { n: "گل و گیاه آپارتمانی", e: "Indoor plants" },
  ],
  handicrafts: [
    { n: "خاتم", e: "Khatam inlay" },
    { n: "مس‌کاری", e: "Copper engraving" },
    { n: "سفال لعاب‌دار", e: "Glazed pottery" },
    { n: "ترمه", e: "Termeh fabric" },
    { n: "قلم‌زنی", e: "Metal embossing" },
  ],

  // ── building ──────────────────────────────────────────────────────────
  "cement-plaster": [
    { n: "سیمان تیپ ۲", e: "Type 2 cement", a: ["سیمان"] },
    { n: "سیمان سفید", e: "White cement" },
    { n: "گچ ساختمانی", e: "Building plaster", a: ["گچ"] },
    { n: "آجر", e: "Brick" },
    { n: "بلوک سفالی", e: "Ceramic block" },
    { n: "بلوک سیمانی", e: "Cement block" },
  ],
  "tile-stone": [
    { n: "کاشی کف", e: "Floor tile", a: ["کاشی"] },
    { n: "کاشی دیوار", e: "Wall tile" },
    { n: "سرامیک کف", e: "Floor ceramic" },
    { n: "سنگ گرانیت", e: "Granite stone" },
    { n: "سنگ مرمریت", e: "Marble stone" },
  ],
  "pipes-fittings": [
    { n: "لوله پنج‌لایه", e: "Five-layer pipe", a: ["لوله"] },
    { n: "لوله پلی‌اتیلن", e: "Polyethylene pipe" },
    { n: "لوله پلیکا", e: "UPVC pipe" },
    { n: "شیر فلکه", e: "Gate valve" },
    { n: "مفصل و اتصالات", e: "Pipe fittings" },
    { n: "رادیاتور پنلی", e: "Panel radiator" },
  ],
  insulation: [
    { n: "ایزوگام", e: "Waterproofing membrane" },
    { n: "عایق حرارتی", e: "Thermal insulation" },
    { n: "پشم شیشه", e: "Glass wool" },
    { n: "فوم پلی‌اتیلن", e: "Polyethylene foam" },
  ],
  "sanitary-ware": [
    { n: "توالت فرنگی", e: "Toilet bowl" },
    { n: "روشویی", e: "Washbasin" },
    { n: "وان حمام", e: "Bathtub" },
    { n: "شیر بهداشتی", e: "Sanitary faucet" },
  ],

  // ── metals ────────────────────────────────────────────────────────────
  "steel-sections": [
    { n: "میلگرد", e: "Rebar" },
    { n: "تیرآهن", e: "I-beam" },
    { n: "ورق گالوانیزه", e: "Galvanized sheet", a: ["ورق"] },
    { n: "ورق سیاه", e: "Hot-rolled sheet" },
    { n: "ناودانی", e: "Channel steel" },
    { n: "پروفیل آهنی", e: "Steel profile" },
    { n: "مفتول", e: "Wire rod" },
    { n: "تسمه آهنی", e: "Steel strip" },
  ],
  "non-ferrous": [
    { n: "شمش مس", e: "Copper ingot", a: ["مس"] },
    { n: "شمش آلومینیوم", e: "Aluminum ingot" },
    { n: "ورق آلومینیوم", e: "Aluminum sheet" },
    { n: "ورق برنج", e: "Brass sheet" },
  ],
  "precious-metals": [
    { n: "شمش طلا", e: "Gold bullion", a: ["شمش"] },
    { n: "طلای ۱۸ عیار", e: "18k gold", a: ["طلا"] },
  ],

  // ── scrap ─────────────────────────────────────────────────────────────
  "scrap-metal": [
    { n: "ضایعات آهن", e: "Iron scrap", a: ["آهن قراضه"] },
    { n: "ضایعات مس", e: "Copper scrap" },
    { n: "ضایعات مس برق", e: "Copper wire scrap" },
    { n: "ضایعات مس شابلون", e: "Copper PCB scrap" },
    { n: "ضایعات آلومینیوم", e: "Aluminum scrap" },
    { n: "ضایعات برنج", e: "Brass scrap" },
  ],
  "scrap-plastic": [
    { n: "ضایعات پلی‌اتیلن", e: "PE scrap" },
    { n: "جام بوتل", e: "PET bales", a: ["پت"] },
    { n: "ضایعات PP", e: "PP scrap" },
    { n: "ضایعات PVC", e: "PVC scrap" },
  ],
  "scrap-paper": [
    { n: "ضایعات کارتن", e: "Cardboard scrap" },
    { n: "ضایعات کاغذ سفید", e: "White paper scrap" },
    { n: "ضایعات روزنامه", e: "Newspaper scrap" },
  ],

  // ── tools ─────────────────────────────────────────────────────────────
  "hand-tools": [
    { n: "آچار فرانسه", e: "Adjustable wrench", a: ["آچار"] },
    { n: "آچار بکس", e: "Box wrench" },
    { n: "پیچ‌گوشتی", e: "Screwdriver" },
    { n: "چکش", e: "Hammer" },
    { n: "انبر", e: "Pliers" },
    { n: "سوهان", e: "File" },
  ],
  "power-tools": [
    { n: "دریل چکشی", e: "Hammer drill", a: ["دریل"] },
    { n: "فرز انگشتی", e: "Angle grinder" },
    { n: "اره برقی", e: "Electric saw" },
    { n: "دیسک برش", e: "Cutting disc" },
    { n: "مته", e: "Drill bit" },
    { n: "پیچ‌گوشتی برقی", e: "Electric screwdriver" },
  ],
  fasteners: [
    { n: "پیچ و مهره", e: "Bolts & nuts", a: ["پیچ"] },
    { n: "واشر", e: "Washer" },
    { n: "لولا", e: "Hinge" },
    { n: "قفل درب", e: "Door lock", a: ["قفل"] },
    { n: "دستگیره درب", e: "Door handle" },
    { n: "رول‌بلاست", e: "Roller shutter lock" },
  ],
  welding: [
    { n: "دستگاه جوش برقی", e: "Welding machine", a: ["جوش"] },
    { n: "سیم جوش", e: "Welding wire" },
    { n: "الکترود جوش", e: "Welding electrode" },
    { n: "ماسک جوش", e: "Welding mask" },
  ],

  // ── electrical ────────────────────────────────────────────────────────
  "wires-cables": [
    { n: "سیم افشان", e: "Stranded wire", a: ["سیم"] },
    { n: "سیم تک‌لا", e: "Solid wire" },
    { n: "کابل برق", e: "Power cable", a: ["کابل"] },
    { n: "کابل مسی", e: "Copper cable" },
    { n: "کابل کنترل", e: "Control cable" },
  ],
  lighting: [
    { n: "لامپ LED", e: "LED lamp", a: ["لامپ"] },
    { n: "پروژکتور LED", e: "LED floodlight" },
    { n: "لوستر", e: "Chandelier" },
    { n: "چراغ خیابانی LED", e: "LED street light" },
  ],
  switchgear: [
    { n: "کلید و پریز", e: "Switch & socket" },
    { n: "فیوز", e: "Fuse" },
    { n: "کلید اتوماتیک", e: "Circuit breaker" },
    { n: "کنتاکتور", e: "Contactor" },
    { n: "تابلو برق", e: "Electrical panel" },
  ],
  "batteries-power": [
    { n: "باتری قلمی", e: "AA battery", a: ["باطری قلمی"] },
    { n: "باتری کتابی", e: "Battery pack" },
    { n: "باتری خودرو", e: "Car battery", a: ["باطری خودرو"] },
    { n: "پنل خورشیدی", e: "Solar panel" },
    { n: "اینورتر خورشیدی", e: "Solar inverter" },
    { n: "دیزل ژنراتور", e: "Diesel generator" },
    { n: "UPS", e: "UPS unit" },
  ],

  // ── automotive ────────────────────────────────────────────────────────
  "spare-parts": [
    { n: "لنت ترمز", e: "Brake pad" },
    { n: "فیلتر روغن", e: "Oil filter" },
    { n: "فیلتر هوا", e: "Air filter" },
    { n: "شمع خودرو", e: "Spark plug" },
    { n: "تسمه تایم", e: "Timing belt" },
    { n: "دیسک ترمز", e: "Brake disc" },
  ],
  tires: [
    { n: "لاستیک سواری", e: "Car tire", a: ["لاستیک"] },
    { n: "لاستیک کامیون", e: "Truck tire" },
    { n: "لاستیک موتورسیکلت", e: "Motorcycle tire" },
    { n: "توشه لاستیک", e: "Inner tube", a: ["تویوب"] },
  ],
  "car-oils": [
    { n: "روغن موتور", e: "Engine oil" },
    { n: "روغن گیربکس", e: "Gearbox oil" },
    { n: "ضدیخ", e: "Antifreeze" },
    { n: "مایع شیشه‌شوی", e: "Windshield fluid" },
    { n: "روغن ترمز", e: "Brake fluid" },
  ],
  "body-parts": [
    { n: "سپر", e: "Bumper" },
    { n: "چراغ جلو", e: "Headlight" },
    { n: "آینه بغل", e: "Side mirror" },
    { n: "گلگیر", e: "Fender" },
  ],

  // ── machinery ─────────────────────────────────────────────────────────
  "production-machines": [
    { n: "دستگاه تزریق پلاستیک", e: "Plastic injection machine" },
    { n: "دستگاه بسته‌بندی", e: "Packaging machine" },
    { n: "دستگاه اکسترودر", e: "Extruder" },
    { n: "دستگاه پرکن مایعات", e: "Liquid filling machine" },
  ],
  "material-handling": [
    { n: "لیفتراک", e: "Forklift" },
    { n: "جک پالت", e: "Pallet jack" },
    { n: "نوار نقاله", e: "Conveyor belt" },
    { n: "پالت پلاستیکی", e: "Plastic pallet" },
  ],
  "pumps-compressors": [
    { n: "پمپ آب", e: "Water pump" },
    { n: "کمپرسور باد", e: "Air compressor" },
    { n: "الکتروموتور", e: "Electric motor" },
    { n: "پمپ گازوئیلی", e: "Diesel pump" },
  ],
  "food-industry": [
    { n: "یخچال صنعتی", e: "Industrial refrigerator" },
    { n: "فر نانوایی", e: "Bakery oven" },
    { n: "خمیرگیر", e: "Dough mixer" },
    { n: "تجهیزات رستوران", e: "Restaurant equipment" },
  ],

  // ── polymers ──────────────────────────────────────────────────────────
  "polymer-raw": [
    { n: "گرانول پلی‌اتیلن", e: "Polyethylene granules", a: ["گرانول"] },
    { n: "پلی‌اتیلن سبک LDPE", e: "LDPE" },
    { n: "پلی‌اتیلن سنگین HDPE", e: "HDPE" },
    { n: "پلی‌پروپیلن", e: "Polypropylene", a: ["PP"] },
    { n: "PVC گرانول", e: "PVC granules" },
    { n: "PET گرید", e: "PET resin" },
    { n: "مستربچ", e: "Masterbatch" },
  ],
  chemicals: [
    { n: "سود سوزآور", e: "Caustic soda" },
    { n: "اسید سولفوریک", e: "Sulfuric acid" },
    { n: "اسید کلریدریک", e: "Hydrochloric acid" },
    { n: "استون", e: "Acetone" },
    { n: "الکل صنعتی", e: "Industrial alcohol" },
    { n: "تینر", e: "Thinner" },
    { n: "گلیسیرین", e: "Glycerin" },
    { n: "کربنات کلسیم", e: "Calcium carbonate" },
  ],
  "paints-colors": [
    { n: "رنگ روغنی ساختمانی", e: "Building oil paint", a: ["رنگ"] },
    { n: "رنگ پلاستیک", e: "Plastic emulsion paint" },
    { n: "رزین پلی‌استر", e: "Polyester resin" },
    { n: "رزین آلکیدی", e: "Alkyd resin" },
    { n: "کربن بلک", e: "Carbon black" },
  ],

  // ── packaging ─────────────────────────────────────────────────────────
  cartons: [
    { n: "کارتن سه‌لایه", e: "Single-wall carton", a: ["کارتن"] },
    { n: "کارتن پنج‌لایه", e: "Double-wall carton" },
    { n: "جعبه مقوایی", e: "Paperboard box" },
    { n: "شیت مقوا", e: "Paperboard sheet" },
  ],
  "films-nylons": [
    { n: "شرینک", e: "Shrink film" },
    { n: "نایلون حبابدار", e: "Bubble wrap" },
    { n: "فیلم سلفون بسته‌بندی", e: "Cellophane film", a: ["سلفون"] },
    { n: "نایلون رول", e: "Nylon roll" },
    { n: "کیسه فریزر", e: "Freezer bags" },
  ],
  disposables: [
    { n: "لیوان یکبارمصرف", e: "Disposable cups" },
    { n: "ظرف فویل", e: "Foil containers" },
    { n: "ظرف غذای خانگی", e: "Food containers" },
    { n: "قاشق و چنگال یکبارمصرف", e: "Disposable cutlery" },
    { n: "سفره یکبارمصرف", e: "Disposable tablecloth" },
  ],
  "labels-print": [
    { n: "برچسب رول", e: "Roll labels", a: ["لیبل"] },
    { n: "کاغذ چاپ", e: "Printing paper" },
    { n: "رول کاغذ حرارتی", e: "Thermal paper roll" },
  ],

  // ── office ────────────────────────────────────────────────────────────
  stationery: [
    { n: "خودکار", e: "Ballpoint pen" },
    { n: "مداد", e: "Pencil" },
    { n: "ماژیک وایت‌برد", e: "Whiteboard marker" },
    { n: "هایلایتر", e: "Highlighter" },
    { n: "چسب ماتیک", e: "Glue stick" },
  ],
  "paper-books": [
    { n: "کاغذ A4", e: "A4 paper", a: ["کاغذ"] },
    { n: "دفتر ۱۰۰ برگ", e: "100-sheet notebook", a: ["دفتر"] },
    { n: "پرونده", e: "File folder" },
    { n: "کلاسور", e: "Ring binder" },
  ],
  "office-consumables": [
    { n: "کارتریج پرینتر", e: "Printer cartridge", a: ["جوهر پرینتر"] },
    { n: "منگنه", e: "Staples" },
    { n: "چسب نواری", e: "Adhesive tape" },
    { n: "گیره کاغذ", e: "Paper clips" },
  ],

  // ── sports-kids ───────────────────────────────────────────────────────
  "sports-equip": [
    { n: "دمبل", e: "Dumbbell" },
    { n: "تردمیل", e: "Treadmill" },
    { n: "توپ فوتبال", e: "Football" },
    { n: "دوچرخه کوهستان", e: "Mountain bike", a: ["دوچرخه"] },
    { n: "تشک تمرین", e: "Exercise mat" },
  ],
  "kids-baby": [
    { n: "کالسکه", e: "Baby stroller" },
    { n: "صندلی ماشین کودک", e: "Child car seat" },
    { n: "تخت کودک", e: "Baby crib" },
  ],
  toys: [
    { n: "عروسک", e: "Doll" },
    { n: "ماشین‌بازی", e: "Toy car" },
    { n: "بلوک ساختنی", e: "Building blocks", a: ["لگو"] },
    { n: "سه‌چرخه", e: "Tricycle" },
  ],

  // ── medical ───────────────────────────────────────────────────────────
  "medical-consumables": [
    { n: "دستکش معاینه", e: "Examination gloves", a: ["دستکش"] },
    { n: "سرنگ", e: "Syringe" },
    { n: "ماسک جراحی", e: "Surgical mask" },
    { n: "باند و گاز", e: "Bandage & gauze" },
    { n: "ست سرم", e: "IV set" },
  ],
  "medical-equip": [
    { n: "تخت بیمارستانی", e: "Hospital bed" },
    { n: "دستگاه فشارسنج", e: "Blood pressure monitor" },
    { n: "ویلچر", e: "Wheelchair" },
    { n: "ترمومتر دیجیتال", e: "Digital thermometer" },
  ],
  "lab-equip": [
    { n: "لوله آزمایش", e: "Test tubes" },
    { n: "پیپت", e: "Pipettes" },
    { n: "ارلن", e: "Erlenmeyer flask" },
  ],

  // ── services (hidden until launch) ────────────────────────────────────
  logistics: [
    { n: "حمل بار جاده‌ای", e: "Road freight", p: true },
    { n: "حمل کانتینری", e: "Container freight", p: true },
  ],
  "contract-production": [
    { n: "خدمات بسته‌بندی", e: "Packaging service", p: true },
    { n: "تولید قراردادی", e: "Contract manufacturing", p: true },
  ],
};
