/**
 * iMach taxonomy v2 — the product-based B2B tree (NO channel roots:
 * «سوپرمارکت» is a shop, not a product family). Depth = 2 (root → leaf);
 * finer distinctions are attributes, not nodes. Slugs are stable forever —
 * names are localizable, slugs are not.
 *
 * Rules encoded here:
 *  - every leaf carries the default wholesale unit for goods created under it
 *  - attrs are SEMANTIC and cross-category keys (weight/packaging/diameter/
 *    size/fat/oilType/capacity) so admin moves never orphan listing values
 *  - services live in a hidden subtree (isActive:false) until launch day
 */

export interface AttrOption {
  v: string;
  fa: string;
  en: string;
}
export interface AttrDef {
  key: string;
  fa: string;
  en: string;
  type: "enum" | "text";
  options?: AttrOption[];
}
export interface LeafDef {
  slug: string;
  nameFa: string;
  nameEn: string;
  unit: string;
  attrs?: AttrDef[];
}
export interface RootDef {
  slug: string;
  nameFa: string;
  nameEn: string;
  children: LeafDef[];
}

const weight: AttrDef = {
  key: "weight",
  fa: "وزن بسته",
  en: "Pack weight",
  type: "enum",
  options: [
    { v: "250g", fa: "۲۵۰ گرمی", en: "250 g" },
    { v: "500g", fa: "۵۰۰ گرمی", en: "500 g" },
    { v: "1kg", fa: "۱ کیلوگرمی", en: "1 kg" },
    { v: "5kg", fa: "۵ کیلوگرمی", en: "5 kg" },
    { v: "10kg", fa: "۱۰ کیلوگرمی", en: "10 kg" },
    { v: "25kg", fa: "۲۵ کیلوگرمی", en: "25 kg" },
    { v: "bulk", fa: "فله", en: "Bulk" },
  ],
};
const packaging: AttrDef = {
  key: "packaging",
  fa: "نوع بسته‌بندی",
  en: "Packaging",
  type: "enum",
  options: [
    { v: "carton", fa: "کارتن", en: "Carton" },
    { v: "jumbo", fa: "جامبو بگ", en: "Jumbo bag" },
    { v: "sack", fa: "کیسه", en: "Sack" },
    { v: "retail", fa: "بسته خرده", en: "Retail pack" },
  ],
};
const diameter: AttrDef = {
  key: "diameter",
  fa: "قطر",
  en: "Diameter",
  type: "enum",
  options: [8, 10, 12, 14, 16, 18, 20, 22, 25].map((d) => ({
    v: String(d),
    fa: `${d} میل`,
    en: `${d} mm`,
  })),
};
const size: AttrDef = {
  key: "size",
  fa: "سایز",
  en: "Size",
  type: "enum",
  options: ["S", "M", "L", "XL", "XXL"].map((s) => ({ v: s, fa: s, en: s })),
};
const fat: AttrDef = {
  key: "fat",
  fa: "درصد چربی",
  en: "Fat level",
  type: "enum",
  options: [
    { v: "full", fa: "پرچرب", en: "Full fat" },
    { v: "low", fa: "کم‌چرب", en: "Low fat" },
    { v: "none", fa: "بی‌چرب", en: "Fat free" },
  ],
};
const oilType: AttrDef = {
  key: "oilType",
  fa: "نوع روغن",
  en: "Oil type",
  type: "enum",
  options: [
    { v: "sunflower", fa: "آفتابگردان", en: "Sunflower" },
    { v: "soybean", fa: "سویا", en: "Soybean" },
    { v: "olive", fa: "زیتون", en: "Olive" },
    { v: "coconut", fa: "نارگیل", en: "Coconut" },
    { v: "brine", fa: "آب نمک", en: "Brine" },
    { v: "tomato", fa: "سس گوجه", en: "Tomato sauce" },
  ],
};
const capacity: AttrDef = {
  key: "capacity",
  fa: "ظرفیت",
  en: "Capacity",
  type: "enum",
  options: [
    { v: "66", fa: "۶۶ آمپر", en: "66 Ah" },
    { v: "74", fa: "۷۴ آمپر", en: "74 Ah" },
    { v: "100", fa: "۱۰۰ آمپر", en: "100 Ah" },
  ],
};

export const TREE: RootDef[] = [
  {
    slug: "food",
    nameFa: "مواد غذایی و آشامیدنی",
    nameEn: "Food & Beverage",
    children: [
      { slug: "rice", nameFa: "برنج", nameEn: "Rice", unit: "KILOGRAM" },
      { slug: "legumes", nameFa: "حبوبات", nameEn: "Legumes", unit: "KILOGRAM" },
      { slug: "flour-cereals", nameFa: "آرد و غلات", nameEn: "Flour & Cereals", unit: "SACK" },
      { slug: "dried-fruit", nameFa: "خشکبار و آجیل", nameEn: "Dried Fruit & Nuts", unit: "KILOGRAM", attrs: [weight, packaging] },
      { slug: "fresh-produce", nameFa: "میوه و سبزیجات", nameEn: "Fresh Produce", unit: "KILOGRAM" },
      { slug: "oils", nameFa: "روغن و خواربار", nameEn: "Oils & Pantry", unit: "CARTON" },
      { slug: "dairy", nameFa: "لبنیات", nameEn: "Dairy", unit: "KILOGRAM", attrs: [fat] },
      { slug: "protein-canned", nameFa: "پروتئین و کنسرو", nameEn: "Protein & Canned", unit: "CARTON", attrs: [oilType] },
      { slug: "sugar-tea", nameFa: "قند، شکر و چای", nameEn: "Sugar & Tea", unit: "SACK" },
      { slug: "spices-saffron", nameFa: "زعفران و ادویه", nameEn: "Saffron & Spices", unit: "KILOGRAM" },
      { slug: "snacks-sweets", nameFa: "تنقلات و شکلات", nameEn: "Snacks & Sweets", unit: "CARTON" },
      { slug: "prepared-food", nameFa: "رب، سس و غذای آماده", nameEn: "Paste, Sauce & Prepared", unit: "CARTON" },
      { slug: "beverages", nameFa: "نوشیدنی", nameEn: "Beverages", unit: "CARTON" },
      { slug: "food-additives", nameFa: "افزودنی خوراکی", nameEn: "Food Additives", unit: "KILOGRAM" },
    ],
  },
  {
    slug: "agri",
    nameFa: "کشاورزی و نهاده‌ها",
    nameEn: "Agriculture & Inputs",
    children: [
      { slug: "fertilizers", nameFa: "کود", nameEn: "Fertilizers", unit: "KILOGRAM" },
      { slug: "seeds-plants", nameFa: "بذر و نهال", nameEn: "Seeds & Saplings", unit: "PIECE" },
      { slug: "pesticides", nameFa: "سموم کشاورزی", nameEn: "Pesticides", unit: "KILOGRAM" },
      { slug: "greenhouse", nameFa: "تجهیزات گلخانه", nameEn: "Greenhouse Equipment", unit: "PIECE" },
    ],
  },
  {
    slug: "livestock",
    nameFa: "دام، طیور و آبزیان",
    nameEn: "Livestock, Poultry & Aquaculture",
    children: [
      { slug: "animal-feed", nameFa: "خوراک دام و طیور", nameEn: "Animal Feed", unit: "SACK" },
      { slug: "forage", nameFa: "علوفه", nameEn: "Forage", unit: "KILOGRAM" },
      { slug: "live-animals", nameFa: "دام زنده", nameEn: "Live Animals", unit: "PIECE" },
      { slug: "poultry-eggs", nameFa: "طیور و تخم‌مرغ", nameEn: "Poultry & Eggs", unit: "KILOGRAM" },
      { slug: "aquaculture", nameFa: "آبزیان", nameEn: "Aquaculture", unit: "KILOGRAM" },
    ],
  },
  {
    slug: "detergents",
    nameFa: "شوینده، بهداشتی و آرایشی",
    nameEn: "Detergents & Personal Care",
    children: [
      { slug: "home-cleaning", nameFa: "شوینده خانگی", nameEn: "Home Cleaning", unit: "CARTON" },
      { slug: "tissue", nameFa: "سلولوزی", nameEn: "Paper & Tissue", unit: "CARTON" },
      { slug: "baby-care", nameFa: "بهداشت کودک", nameEn: "Baby Care", unit: "CARTON", attrs: [size] },
      { slug: "personal-care", nameFa: "مراقبت شخصی", nameEn: "Personal Care", unit: "CARTON" },
      { slug: "cosmetics", nameFa: "آرایشی", nameEn: "Cosmetics", unit: "CARTON" },
    ],
  },
  {
    slug: "textile",
    nameFa: "پوشاک، منسوجات و فرش",
    nameEn: "Apparel, Textiles & Carpets",
    children: [
      { slug: "fabrics", nameFa: "پارچه", nameEn: "Fabric", unit: "METER" },
      { slug: "yarn", nameFa: "نخ و الیاف", nameEn: "Yarn & Fibers", unit: "KILOGRAM" },
      { slug: "garments", nameFa: "پوشاک عمده", nameEn: "Wholesale Garments", unit: "PIECE", attrs: [size] },
      { slug: "carpets-rugs", nameFa: "فرش و منسوجات خانه", nameEn: "Carpets & Home Textiles", unit: "PIECE" },
    ],
  },
  {
    slug: "footwear",
    nameFa: "کفش، چرم و کیف",
    nameEn: "Footwear, Leather & Bags",
    children: [
      { slug: "shoes", nameFa: "کفش", nameEn: "Shoes", unit: "PIECE", attrs: [size] },
      { slug: "bags-leather", nameFa: "کیف و چرم", nameEn: "Bags & Leather", unit: "PIECE" },
    ],
  },
  {
    slug: "home-appliances",
    nameFa: "لوازم خانگی و آشپزخانه",
    nameEn: "Home Appliances & Kitchenware",
    children: [
      { slug: "major-appliances", nameFa: "لوازم برقی بزرگ", nameEn: "Major Appliances", unit: "PIECE" },
      { slug: "kitchen-electric", nameFa: "لوازم برقی آشپزخانه", nameEn: "Kitchen Appliances", unit: "PIECE" },
      { slug: "cookware", nameFa: "ظروف و سرویس", nameEn: "Cookware & Tableware", unit: "PIECE" },
    ],
  },
  {
    slug: "digital",
    nameFa: "کالای دیجیتال و موبایل",
    nameEn: "Digital & Mobile",
    children: [
      { slug: "mobile-accessories", nameFa: "موبایل و لوازم جانبی", nameEn: "Mobile & Accessories", unit: "PIECE" },
      { slug: "computer-network", nameFa: "کامپیوتر و شبکه", nameEn: "Computers & Network", unit: "PIECE" },
      { slug: "storage", nameFa: "ذخیره‌سازی", nameEn: "Storage", unit: "PIECE" },
    ],
  },
  {
    slug: "furniture",
    nameFa: "مبلمان، اداری و دکوراسیون",
    nameEn: "Furniture, Office & Decor",
    children: [
      { slug: "home-furniture", nameFa: "مبلمان خانگی", nameEn: "Home Furniture", unit: "PIECE" },
      { slug: "office-furniture", nameFa: "مبلمان اداری", nameEn: "Office Furniture", unit: "PIECE" },
      { slug: "decor", nameFa: "دکور و تزئینات", nameEn: "Decor", unit: "PIECE" },
      { slug: "handicrafts", nameFa: "صنایع دستی", nameEn: "Handicrafts", unit: "PIECE" },
    ],
  },
  {
    slug: "building",
    nameFa: "مصالح ساختمانی و تاسیسات",
    nameEn: "Building Materials & Installations",
    children: [
      { slug: "cement-plaster", nameFa: "سیمان، گچ و آجر", nameEn: "Cement, Plaster & Brick", unit: "KILOGRAM" },
      { slug: "tile-stone", nameFa: "کاشی، سرامیک و سنگ", nameEn: "Tile, Ceramic & Stone", unit: "PIECE" },
      { slug: "pipes-fittings", nameFa: "لوله و شیرآلات", nameEn: "Pipes & Valves", unit: "PIECE" },
      { slug: "insulation", nameFa: "عایق و ایزولاسیون", nameEn: "Insulation", unit: "PIECE" },
      { slug: "sanitary-ware", nameFa: "سرامیک بهداشتی", nameEn: "Sanitary Ware", unit: "PIECE" },
    ],
  },
  {
    slug: "metals",
    nameFa: "آهن‌آلات و فلزات",
    nameEn: "Metals & Steel",
    children: [
      { slug: "steel-sections", nameFa: "مقاطع فولادی", nameEn: "Steel Sections", unit: "TON", attrs: [diameter] },
      { slug: "non-ferrous", nameFa: "فلزات غیرآهنی", nameEn: "Non-ferrous Metals", unit: "KILOGRAM" },
      { slug: "precious-metals", nameFa: "طلا و گرانبها", nameEn: "Precious Metals", unit: "GRAM" },
    ],
  },
  {
    slug: "scrap",
    nameFa: "ضایعات و بازیافت",
    nameEn: "Scrap & Recycling",
    children: [
      { slug: "scrap-metal", nameFa: "ضایعات فلزی", nameEn: "Metal Scrap", unit: "KILOGRAM" },
      { slug: "scrap-plastic", nameFa: "ضایعات پلاستیک", nameEn: "Plastic Scrap", unit: "KILOGRAM" },
      { slug: "scrap-paper", nameFa: "ضایعات کاغذ", nameEn: "Paper Scrap", unit: "TON" },
    ],
  },
  {
    slug: "tools",
    nameFa: "ابزار و یراق‌آلات",
    nameEn: "Tools & Hardware",
    children: [
      { slug: "hand-tools", nameFa: "ابزار دستی", nameEn: "Hand Tools", unit: "PIECE" },
      { slug: "power-tools", nameFa: "ابزار برقی", nameEn: "Power Tools", unit: "PIECE" },
      { slug: "fasteners", nameFa: "یراق و اتصالات", nameEn: "Fasteners", unit: "PIECE" },
      { slug: "welding", nameFa: "جوش و برش", nameEn: "Welding & Cutting", unit: "PIECE" },
    ],
  },
  {
    slug: "electrical",
    nameFa: "برق، روشنایی و انرژی",
    nameEn: "Electrical, Lighting & Energy",
    children: [
      { slug: "wires-cables", nameFa: "سیم و کابل", nameEn: "Wires & Cables", unit: "METER" },
      { slug: "lighting", nameFa: "روشنایی", nameEn: "Lighting", unit: "PIECE" },
      { slug: "switchgear", nameFa: "تابلو و کلید پریز", nameEn: "Switchgear", unit: "PIECE" },
      { slug: "batteries-power", nameFa: "باتری و انرژی", nameEn: "Batteries & Power", unit: "PIECE", attrs: [capacity] },
    ],
  },
  {
    slug: "automotive",
    nameFa: "خودرو، موتورسیکلت و قطعات",
    nameEn: "Automotive & Parts",
    children: [
      { slug: "spare-parts", nameFa: "قطعات یدکی", nameEn: "Spare Parts", unit: "PIECE" },
      { slug: "tires", nameFa: "لاستیک", nameEn: "Tires", unit: "PIECE" },
      { slug: "car-oils", nameFa: "روغن و مایعات خودرو", nameEn: "Auto Oils & Fluids", unit: "CARTON" },
      { slug: "body-parts", nameFa: "بدنه و چراغ", nameEn: "Body & Lights", unit: "PIECE" },
    ],
  },
  {
    slug: "machinery",
    nameFa: "ماشین‌آلات و تجهیزات صنعتی",
    nameEn: "Machinery & Industrial Equipment",
    children: [
      { slug: "production-machines", nameFa: "ماشین‌آلات تولید", nameEn: "Production Machinery", unit: "PIECE" },
      { slug: "material-handling", nameFa: "جابه‌جایی مواد", nameEn: "Material Handling", unit: "PIECE" },
      { slug: "pumps-compressors", nameFa: "پمپ و کمپرسور", nameEn: "Pumps & Compressors", unit: "PIECE" },
      { slug: "food-industry", nameFa: "تجهیزات صنعت غذا", nameEn: "Food Industry Equipment", unit: "PIECE" },
    ],
  },
  {
    slug: "polymers",
    nameFa: "پلیمر، شیمیایی و رنگ",
    nameEn: "Polymers, Chemicals & Paint",
    children: [
      { slug: "polymer-raw", nameFa: "مواد اولیه پلیمری", nameEn: "Polymer Raw Materials", unit: "KILOGRAM" },
      { slug: "chemicals", nameFa: "مواد شیمیایی", nameEn: "Industrial Chemicals", unit: "KILOGRAM" },
      { slug: "paints-colors", nameFa: "رنگ و رزین", nameEn: "Paint & Resin", unit: "KILOGRAM" },
    ],
  },
  {
    slug: "packaging",
    nameFa: "بسته‌بندی، چاپ و یکبارمصرف",
    nameEn: "Packaging, Print & Disposables",
    children: [
      { slug: "cartons", nameFa: "کارتن و مقوا", nameEn: "Cartons & Paperboard", unit: "PIECE" },
      { slug: "films-nylons", nameFa: "نایلون و فیلم", nameEn: "Films & Nylon", unit: "PIECE" },
      { slug: "disposables", nameFa: "ظروف یکبارمصرف", nameEn: "Disposables", unit: "CARTON" },
      { slug: "labels-print", nameFa: "چاپ و لیبل", nameEn: "Print & Labels", unit: "PIECE" },
    ],
  },
  {
    slug: "office",
    nameFa: "لوازم‌التحریر، اداری و کاغذ",
    nameEn: "Office & Stationery",
    children: [
      { slug: "stationery", nameFa: "نوشت‌افزار", nameEn: "Stationery", unit: "CARTON" },
      { slug: "paper-books", nameFa: "کاغذ و دفتر", nameEn: "Paper & Notebooks", unit: "CARTON" },
      { slug: "office-consumables", nameFa: "مصرفی اداری", nameEn: "Office Consumables", unit: "PIECE" },
    ],
  },
  {
    slug: "sports-kids",
    nameFa: "ورزش، کودک و اسباب‌بازی",
    nameEn: "Sports, Kids & Toys",
    children: [
      { slug: "sports-equip", nameFa: "تجهیزات ورزشی", nameEn: "Sports Equipment", unit: "PIECE" },
      { slug: "kids-baby", nameFa: "سیسمونی و کودک", nameEn: "Baby & Kids", unit: "PIECE" },
      { slug: "toys", nameFa: "اسباب‌بازی", nameEn: "Toys", unit: "CARTON" },
    ],
  },
  {
    slug: "medical",
    nameFa: "تجهیزات پزشکی و آزمایشگاهی",
    nameEn: "Medical & Lab Equipment",
    children: [
      { slug: "medical-consumables", nameFa: "مصرفی پزشکی", nameEn: "Medical Consumables", unit: "CARTON" },
      { slug: "medical-equip", nameFa: "تجهیزات درمانی", nameEn: "Medical Equipment", unit: "PIECE" },
      { slug: "lab-equip", nameFa: "تجهیزات آزمایشگاه", nameEn: "Lab Equipment", unit: "PIECE" },
    ],
  },
];

/** Hidden until launch day — kept in the DB, excluded from every read. */
export const HIDDEN_TREE: RootDef[] = [
  {
    slug: "services",
    nameFa: "خدمات",
    nameEn: "Services",
    children: [
      { slug: "logistics", nameFa: "حمل و نقل", nameEn: "Logistics", unit: "SERVICE" },
      { slug: "contract-production", nameFa: "تولید و بسته‌بندی سفارشی", nameEn: "Contract Production", unit: "SERVICE" },
    ],
  },
];

/** Legacy (v1) slugs that now live under a NEW parent — upsert re-parents. */
export const REUSED_SLUGS = new Set([
  "dried-fruit", "livestock", "polymers", "packaging", "metals", "scrap",
  "chemicals", "dairy", "services", "logistics", "contract-production",
]);

/** Legacy v1 nodes to delete after their goods are moved (leaf-first order). */
export const LEGACY_DELETE = [
  "grains-legumes", "fruits-veg", "gold-items",
  "agri-food", "supermarket", "industry", "apparel", "gold",
];

/** Fallback per legacy slug: any unmapped leftover good lands here. */
export const LEGACY_ROOT_FALLBACK: Record<string, string> = {
  "agri-food": "fresh-produce",
  "grains-legumes": "rice",
  "fruits-veg": "fresh-produce",
  pantry: "oils",
  drinks: "beverages",
  "bakery-snacks": "snacks-sweets",
  steel: "steel-sections",
  copper: "non-ferrous",
  "metal-scrap": "scrap-metal",
  "plastic-scrap": "scrap-plastic",
  clothing: "garments",
  fabric: "fabrics",
  "gold-items": "precious-metals",
  supermarket: "oils",
  industry: "chemicals",
  apparel: "garments",
  gold: "precious-metals",
  services: "logistics",
};
export const LEGACY_GOOD_MOVES: Record<string, string> = {
  "خرمای خازویی": "dried-fruit",
  "خرمای پیارم": "dried-fruit",
  "خرمای مضافتی": "dried-fruit",
  "برنج هاشمی": "rice",
  "تخم‌مرغ": "poultry-eggs",
  "مرغ گرم": "poultry-eggs",
  "روغن نباتی": "oils",
  "شکر": "sugar-tea",
  "ماکارونی": "prepared-food",
  "رب گوجه‌فرنگی": "prepared-food",
  "چای سیاه": "sugar-tea",
  "آب‌میوه": "beverages",
  "نوشابه": "beverages",
  "پنیر": "dairy",
  "کره حیوانی": "dairy",
  "شیر پاستوریزه": "dairy",
  "کیک یزدی": "snacks-sweets",
  "کیک شطرنجی": "snacks-sweets",
  "کیک هویج": "snacks-sweets",
  "کیک پرتقالی": "snacks-sweets",
  "کلوچه کشمشی": "snacks-sweets",
  "شکلات": "snacks-sweets",
  "بیسکویت": "snacks-sweets",
  "گرانول پلی‌اتیلن": "polymer-raw",
  "مستربچ": "polymer-raw",
  "کارتن بسته‌بندی": "cartons",
  "فیلم سلفون بسته‌بندی": "films-nylons",
  "پودر کاکائو": "food-additives",
  "اسید سیتریک": "food-additives",
  "میلگرد": "steel-sections",
  "ورق گالوانیزه": "steel-sections",
  "تیرآهن": "steel-sections",
  "شمش مس": "non-ferrous",
  "کابل مسی": "wires-cables",
  "ضایعات آهن": "scrap-metal",
  "ضایعات مس": "scrap-metal",
  "ضایعات آلومینیوم": "scrap-metal",
  "ضایعات پلی‌اتیلن": "scrap-plastic",
  "جام بوتل": "scrap-plastic",
  "شلوار جین": "garments",
  "تیشرت": "garments",
  "پارچه نخی": "fabrics",
  "پارچه پلی‌استر": "fabrics",
  "شمش طلا": "precious-metals",
  "طلای ۱۸ عیار": "precious-metals",
  "حمل بار جاده‌ای": "logistics",
  "حمل کانتینری": "logistics",
  "خدمات بسته‌بندی": "contract-production",
  "تولید قراردادی": "contract-production",
};
