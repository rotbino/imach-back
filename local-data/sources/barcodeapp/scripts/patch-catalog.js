const fs = require('fs');
const catalog = JSON.parse(fs.readFileSync('/home/z/imach-back/local-data/reference/reference-catalog-v3.json', 'utf8'));

// Helper to find a good by slug
function find(slug) { return catalog.goods.find(g => g.slug === slug); }

// Helper to add a new good
function add(slug, nameFa, nameEn, aliases, keywords, excludeKeywords, mustMatchAny, gs1, hs, unit, categoryId, attrs) {
  const g = { slug, nameFa, nameEn, aliases, keywords, excludeKeywords };
  if (mustMatchAny && mustMatchAny.length > 0) g.must_match_any_keyword_group = mustMatchAny;
  g.gs1GpcCode = gs1; g.hsCode = hs; g.unit = unit; g.categoryId = categoryId;
  g.attrs = attrs || [];
  catalog.goods.push(g);
}

// Helper to split a combined good into separate ones
function splitGood(oldSlug, newGoods) {
  const idx = catalog.goods.findIndex(g => g.slug === oldSlug);
  if (idx === -1) { console.log('WARN: ' + oldSlug + ' not found'); return; }
  catalog.goods.splice(idx, 1);
  for (const ng of newGoods) {
    catalog.goods.push(ng);
  }
}

// === FIX 1: Split "شیره خرما و شیره انگور" into two separate goods ===
splitGood('date-syrup-silice', [
  {
    slug: 'date-syrup', nameFa: 'شیره خرما', nameEn: 'Date Syrup',
    aliases: ['شیره خرما','شيره خرما'], keywords: ['شیره','خرما'], excludeKeywords: ['انگور'],
    gs1GpcCode: '50202436', hsCode: '1702', unit: 'CARTON', categoryId: 'sugar-tea',
    attrs: [{key:'volume_ml',fa:'حجم',type:'text'}]
  },
  {
    slug: 'grape-syrup', nameFa: 'شیره انگور', nameEn: 'Grape Syrup',
    aliases: ['شیره انگور','شيره انگور'], keywords: ['شیره','انگور'], excludeKeywords: ['خرما'],
    gs1GpcCode: '50202436', hsCode: '1702', unit: 'CARTON', categoryId: 'sugar-tea',
    attrs: [{key:'volume_ml',fa:'حجم',type:'text'}]
  }
]);

// === FIX 2: Split "پنیر چدار و پارمسان عمل‌آمده" — actually this IS one type (aged hard cheese). Keep as is but rename ===
const chdar = find('dairy-protein-cheese-yellow-hard-cured');
if (chdar) {
  chdar.nameFa = 'پنیر عمل‌آمده (چدار/پارمسان)';
  chdar.keywords = ['پنیر'];
  chdar.must_match_any_keyword_group = [['چدار','پارمسان','عمل‌آمده','عمل آورده']];
  chdar.excludeKeywords = ['ورقه','اسلایس','سفید','پیتزا','موزارلا','خامه','کرم','طهرانگرم','زرشک','سبزی','فلفل','گردو','لیقوان','لبنه','پروسس','دیپ','رنده'];
}

// === FIX 3: Add "سس گوجه فرنگی" (tomato sauce, different from ketchup) ===
add('tomato-sauce','سس گوجه فرنگی','Tomato Sauce',
  ['سس گوجه','سس گوجه فرنگی','سس مارینارا'],
  ['سس','گوجه'],
  ['مایونز','کچاپ','خردل','باربکیو','سیریاچا','تارتار','فرانسوی','هزار جزیره','پیتزا','استیک','فلفل'],
  [],
  '50202470','2103','CARTON','prepared-food',
  [{key:'weight_g',fa:'وزن',type:'text'}]);

// === FIX 4: Add "کره بادام زمینی" (peanut butter - very different from raw peanuts) ===
add('peanut-butter','کره بادام زمینی','Peanut Butter',
  ['کره بادام زمینی','بادام زمینی کره','پی‌نات‌باتر'],
  ['کره بادام','بادام زمینی کره','پی‌نات باتر','پسته باتر'],
  [],
  [],
  '50202315','2008','CARTON','snacks-sweets',
  [{key:'type',fa:'نوع',type:'enum',options:['کرمی','تکه‌دار']},{key:'weight_g',fa:'وزن',type:'text'}]);

// === FIX 5: Add "دستمال کاغذی" as keyword to toilet-paper-tissue ===
const tp = find('toilet-paper-tissue');
if (tp) {
  if (!tp.keywords.includes('دستمال کاغذی')) tp.keywords.push('دستمال کاغذی');
  if (!tp.keywords.includes('دستمال توالت')) tp.keywords.push('دستمال توالت');
  // But exclude kitchen and facial
  ['دستمال صورت','دستمال آشپزخانه','روی‌میز','صورت','کاغذی مرطوب','بشقاب','لیوان','مرطوب'].forEach(ex => {
    if (!tp.excludeKeywords.includes(ex)) tp.excludeKeywords.push(ex);
  });
}

// === FIX 6: Add "شامپو سر" and "شامپو" to shampoo-hair keywords ===
const sh = find('shampoo-hair');
if (sh) {
  sh.keywords = ['شامپو'];
  sh.excludeKeywords = ['فرش','مبلمان','ماشین','ژل حمام','بادی','سر و بدن'];
  // Remove 'بدن' from excludes - body wash is separate good. But "شامپو بدن" should go to body-wash
  // Keep 'کودک' in excludes - baby shampoo has its own good
  if (!sh.excludeKeywords.includes('کودک')) sh.excludeKeywords.push('کودک');
  // Add "شامپو سر" as alias
  if (!sh.aliases.includes('شامپو سر')) sh.aliases.push('شامپو سر');
  if (!sh.aliases.includes('شامپو ضد شوره')) sh.aliases.push('شامپو ضد شوره');
  if (!sh.aliases.includes('شامپو ضد ریزش')) sh.aliases.push('شامپو ضد ریزش');
}

// === FIX 7: Add "سفید کننده" as keyword to bleach ===
const bl = find('bleach-whitener');
if (bl) {
  if (!bl.keywords.includes('سفیدکننده')) bl.keywords.push('سفیدکننده');
  if (!bl.keywords.includes('سفید کننده')) bl.keywords.push('سفید کننده');
  if (!bl.keywords.includes('وایتکس')) bl.keywords.push('وایتکس');
}

// === FIX 8: Add "نوار بهداشتی" to sanitary-pad ===
const sp = find('sanitary-pad');
if (sp) {
  if (!sp.keywords.includes('نوار بهداشتی')) sp.keywords.push('نوار بهداشتی');
  if (!sp.keywords.includes('پد بهداشتی')) sp.keywords.push('پد بهداشتی');
  if (!sp.keywords.includes('پد روزانه')) sp.keywords.push('پد روزانه');
}

// === FIX 9: Add "جرم گیر" variant to descaler ===
const ds = find('descaler-limescale');
if (ds) {
  if (!ds.keywords.includes('جرم‌گیر')) ds.keywords.push('جرم‌گیر');
  if (!ds.keywords.includes('جرم گیر')) ds.keywords.push('جرم گیر');
  if (!ds.keywords.includes('جرم‌بر')) ds.keywords.push('جرم‌بر');
}

// === FIX 10: Add "پد ظرفشویی" to scouring-pad ===
const sc = find('scouring-pad-sponge');
if (sc) {
  if (!sc.keywords.includes('پد ظرفشویی')) sc.keywords.push('پد ظرفشویی');
  if (!sc.keywords.includes('پد اسفنجی')) sc.keywords.push('پد اسفنجی');
}

// === FIX 11: Add "شمع" and "وارمر" as new good ===
add('candle-warmer','شمع و وارمر','Candle & Warmer',
  ['شمع','وارمر','شمع معطر','شمع آرایشی','شمع دکوری'],
  ['شمع','وارمر'],
  [],
  [],
  '10002670','3406','PIECE','home-furniture',
  [{key:'type',fa:'نوع',type:'enum',options:['شمع معطر','شمع دکوری','وارمر']}]);

// === FIX 12: Add "قارچ دکمه" to fresh-produce ===
add('mushroom-fresh','قارچ تازه','Fresh Mushroom',
  ['قارچ دکمه','قارچ','دکمه'],
  ['قارچ'],
  ['خشک','کنسرو'],
  [],
  '10002675','0709','KILOGRAM','fresh-produce',
  [{key:'type',fa:'نوع',type:'enum',options:['دکمه','صدفی','گلدن']}]);


// === FIX 13: Add "سبزی خوردن" to fresh-produce ===
add('fresh-herbs-vegetables','سبزی تازه و سبزی خوردن','Fresh Herbs & Vegetables',
  ['سبزی خوردن','سبزی تازه','سبزیجات تازه'],
  ['سبزی خوردن','سبزی تازه','سبزیجات'],
  ['خشک','کنسرو','منجمد'],
  [],
  '10002675','0709','KILOGRAM','fresh-produce',
  [{key:'type',fa:'نوع',type:'enum',options:['سبزی خوردن','سبزی آش','سبزی پلویی','تره']}]);


// === FIX 14: Add "پودر سیر" and "پودر زردچوبه" as spice-single variants ===
const tmc = find('turmeric');
if (tmc) {
  if (!tmc.aliases.includes('پودر زردچوبه')) tmc.aliases.push('پودر زردچوبه');
  if (!tmc.aliases.includes('زردچوبه پودر')) tmc.aliases.push('زردچوبه پودر');
}
// Add dried garlic powder as separate good
add('garlic-powder-dried','پودر سیر و سیر خشک','Garlic Powder',
  ['پودر سیر','سیر خشک','سیر پودر','گرانول سیر'],
  ['پودر سیر','سیر خشک','گرانول سیر','سیر پودر'],
  ['سیر ترشی','سیر تازه','سیر نمک'],
  [],
  '50202456','0712','KILOGRAM','spices-saffron',
  [{key:'form',fa:'نوع',type:'enum',options:['پودر','گرانول','پرک']}]);

// === FIX 15: Add "آش رشته" and "فلافل" and "شنیسل مرغ" as ready meals ===
add('ash-reshte','آش رشته و آش آماده','Ash Reshte',
  ['آش رشته','آش آماده','آش'],
  ['آش'],
  ['سوپ','خورش'],
  [],
  '50202510','2104','CARTON','prepared-food',
  [{key:'type',fa:'نوع',type:'enum',options:['آش رشته','آش سبزی','آش دوغ','آش جو']}]);


// === FIX 16: Add "ارده" (tahini) as separate good ===
add('tahini','ارده (سکنجبین)','Tahini',
  ['ارده','سکنجبین','ارده کنجد'],
  ['ارده'],
  ['حلوا','شیره'],
  [],
  '50202365','1515','CARTON','prepared-food',
  [{key:'weight_g',fa:'وزن',type:'text'}]);


// === FIX 17: Add "روغن بدن" as alias to body-hand-lotion ===
const bhl = find('body-hand-lotion');
if (bhl) {
  if (!bhl.keywords.includes('روغن بدن')) bhl.keywords.push('روغن بدن');
  if (!bhl.aliases.includes('روغن بدن ویتامین')) bhl.aliases.push('روغن بدن ویتامین');
  if (!bhl.aliases.includes('روغن کودک')) bhl.aliases.push('روغن کودک');
}

// === FIX 18: Add "گوش پاک کن" to cotton-pad ===
const cp = find('cotton-pad-makeup');
if (cp) {
  if (!cp.keywords.includes('گوش پاک کن')) cp.keywords.push('گوش پاک کن');
  if (!cp.keywords.includes('گوش پاک‌کن')) cp.keywords.push('گوش پاک‌کن');
}

// === FIX 19: Add "خودتراش" and "خود تراش" to razor ===
const rz = find('razor-shaving-gel');
if (rz) {
  if (!rz.keywords.includes('خودتراش')) rz.keywords.push('خودتراش');
  if (!rz.keywords.includes('خود تراش')) rz.keywords.push('خود تراش');
  if (!rz.keywords.includes('ریش تراش')) rz.keywords.push('ریش تراش');
  if (!rz.keywords.includes('فوم اصلاح')) rz.keywords.push('فوم اصلاح');
}

// === FIX 20: Add "کشت سبز" to legumes (it's a type of bean) ===
add('green-grams-cowpea','کشت سبز و لوبیا سبز','Green Gram',
  ['کشت سبز','لوبیا سبز'],
  ['کشت سبز','لوبیا سبز'],
  [],
  [],
  '50202445','0713','SACK','legumes',
  [{key:'weight_g',fa:'وزن',type:'text'}]);

// === FIX 21: Add "جو پوست کنده" and "گندم پوست کنده" to flour-cereals ===
add('pearled-wheat-barley','گندم و جو پوست‌کنده','Pearled Wheat/Barley',
  ['جو پوست','گندم پوست','جو پرک','گندم پرک','پوست کنده'],
  ['پوست کنده','پوست‌کنده','پرک'],
  ['آرد','نشاسته'],
  [],
  '50202425','1104','SACK','flour-cereals',
  [{key:'type',fa:'نوع',type:'enum',options:['گندم','جو']},{key:'weight_g',fa:'وزن',type:'text'}]);

// === FIX 22: Add "کرم موبر" and "کرم ترک" to personal-care ===
add('depilatory-cream','کرم موبر و کرم دپیلاتوری','Depilatory Cream',
  ['کرم موبر','کرم دپیلاتوری','کرم ترک','کرم مو بر','وکس بدن'],
  ['کرم موبر','کرم دپیلاتوری','کرم ترک','وکس بدن','کرم مو بر'],
  [],
  [],
  '10002545','3304','CARTON','personal-care',
  [{key:'use_area',fa:'ناحیه',type:'enum',options:['بدن','صورت','دست و پا']}]);


// === FIX 23: Add "خوشبوکننده بدن" to deodorant/perfume — make it match body-splash or deodorant ===
const bs = find('body-splash');
if (bs) {
  if (!bs.keywords.includes('اسپری خوشبوکننده بدن')) bs.keywords.push('اسپری خوشبوکننده بدن');
  if (!bs.keywords.includes('اسپری بدن')) bs.keywords.push('اسپری بدن');
  if (!bs.keywords.includes('اسپری خوشبو')) bs.keywords.push('اسپری خوشبو');
}

// === FIX 24: Add "اسپری مو" to hair-styling ===
const hs2 = find('hair-styling-gel-wax-foam');
if (hs2) {
  if (!hs2.keywords.includes('اسپری مو')) hs2.keywords.push('اسپری مو');
  if (!hs2.keywords.includes('موس حالت')) hs2.keywords.push('موس حالت');
  if (!hs2.keywords.includes('موس‌حالت')) hs2.keywords.push('موس‌حالت');
  if (!hs2.keywords.includes('لاک مو')) hs2.keywords.push('لاک مو');
}

// === FIX 25: Add "دستمال حوله‌ای" to facial-tissue or toilet-paper ===
const ft = find('facial-tissue-napkin');
if (ft) {
  if (!ft.keywords.includes('دستمال حوله')) ft.keywords.push('دستمال حوله');
  if (!ft.keywords.includes('دستمال حوله‌ای')) ft.keywords.push('دستمال حوله‌ای');
  if (!ft.keywords.includes('دستمال میکروفایبر')) ft.keywords.push('دستمال میکروفایبر');
}

// === FIX 26: Add "فندک آشپزخانه" and "اسپری گاز" to charcoal/household ===
add('kitchen-lighter','فندک آشپزخانه و فندک','Kitchen Lighter',
  ['فندک آشپزخانه','فندک','فندک گازی','اسپری گاز فندک'],
  ['فندک','اسپری گاز'],
  [],
  [],
  '10002645','3606','PIECE','hand-tools',
  [{key:'type',fa:'نوع',type:'enum',options:['آشپزخانه','جیبی','گازی']}]);


// === FIX 27: Add "فلافل" and "شنیسل" to ready-meal ===
const rm = find('ready-meal-stew');
if (rm) {
  if (!rm.aliases.includes('فلافل')) rm.aliases.push('فلافل');
  if (!rm.aliases.includes('شنیسل مرغ')) rm.aliases.push('شنیسل مرغ');
  if (!rm.keywords.includes('فلافل')) rm.keywords.push('فلافل');
  if (!rm.keywords.includes('شنیسل')) rm.keywords.push('شنیسل');
}

// === FIX 28: Add "میگو" to protein-canned ===
add('shrimp-seafood-fresh','میگو و غذای دریایی تازه','Fresh Seafood',
  ['میگو','میگو تازه','میگو منجمد'],
  ['میگو'],
  ['خشک','کنسرو','ساردین','ماکرل'],
  [],
  '10002670','0306','KILOGRAM','protein-canned',
  [{key:'type',fa:'نوع',type:'enum',options:['میگو','سالباند','مارماهی']}]);


// === FIX 29: Add "قرص ضدعفونی" to toilet-cleaner or disinfectant ===
const dc = find('disinfectant-surface');
if (dc) {
  if (!dc.keywords.includes('قرص ضدعفونی')) dc.keywords.push('قرص ضدعفونی');
}
const tc = find('toilet-cleaner');
if (tc) {
  if (!tc.keywords.includes('قرص توالت')) tc.keywords.push('قرص توالت');
  if (!tc.keywords.includes('قرص ضدعفونی توالت')) tc.keywords.push('قرص ضدعفونی توالت');
}

// === FIX 30: Add "عسل" alternate spellings to honey ===
const hn = find('honey');
if (hn) {
  if (!hn.aliases.includes('عسل طبیعی')) hn.aliases.push('عسل طبیعی');
  if (!hn.aliases.includes('عسل گرم')) hn.aliases.push('عسل گرم');
  if (!hn.aliases.includes('عسل مصنوعی')) hn.aliases.push('عسل مصنوعی');
}

// === FIX 31: Add "کره بادام" (almond butter) as separate from peanut butter ===
add('almond-butter','کره بادام','Almond Butter',
  ['کره بادام','بادام کره','آلومند باتر'],
  ['کره بادام درختی','آلومند باتر','بادام کره'],
  ['بادام زمینی','بادام خام','بادام برشته'],
  [],
  '50202315','2008','CARTON','snacks-sweets',
  [{key:'weight_g',fa:'وزن',type:'text'}]);

// === FIX 32: Add "تخمه ژاپنی" and "تخمه هندوانه" to seeds ===
const ss = find('sunflower-seed');
if (ss) {
  if (!ss.keywords.includes('تخمه ژاپنی')) ss.keywords.push('تخمه ژاپنی');
}
const ps = find('pumpkin-seed');
if (ps) {
  if (!ps.keywords.includes('تخمه هندوانه')) ps.keywords.push('تخمه هندوانه');
}

// === FIX 33: Add "چای" generic keyword to tea-black-bulk-simple ===
const tb = find('tea-black-bulk-simple');
if (tb) {
  // This is the "catch-all" for plain tea
  if (!tb.excludeKeywords.includes('سبز')) tb.excludeKeywords.push('سبز');
  if (!tb.excludeKeywords.includes('دمنوش')) tb.excludeKeywords.push('دمنوش');
  if (!tb.excludeKeywords.includes('کیسه')) tb.excludeKeywords.push('کیسه');
  if (!tb.excludeKeywords.includes('سرد')) tb.excludeKeywords.push('سرد');
  if (!tb.excludeKeywords.includes('یخ')) tb.excludeKeywords.push('یخ');
}

// === FIX 34: Add "سفیدکننده غلیظ" to bleach ===
const bl2 = find('bleach-whitener');
if (bl2) {
  if (!bl2.aliases.includes('سفیدکننده غلیظ')) bl2.aliases.push('سفیدکننده غلیظ');
  if (!bl2.aliases.includes('سفیدکننده لباس')) bl2.aliases.push('سفیدکننده لباس');
}

// === FIX 35: Add "پودر لکه" and "اسپری لکه" to laundry ===
add('stain-remover','پاک‌کننده لکه لباس','Stain Remover',
  ['پاک‌کننده لکه','پودر لکه','اسپری لکه','مایع لکه','لکه بر'],
  ['لکه','لکه‌بر','لکه بر'],
  [],
  [],
  '10002415','3402','CARTON','home-cleaning',
  [{key:'form',fa:'نوع',type:'enum',options:['اسپری','پودر','مایع','ژل']}]);

// === FIX 36: Add "ژل آتش" and "ژل شستشو" ===
add('fire-gel','ژل آتش و فندک شعله‌زا','Fire Gel',
  ['ژل آتش','ژل آتش‌زا','فندک شعله','ایزی فایر'],
  ['ژل آتش','ایزی فایر','ژل آتش‌زا'],
  ['اصلاح','شستشو','بهداشتی','حمام'],
  [],
  '10002670','3606','CARTON','hand-tools',
  [{key:'weight_g',fa:'وزن',type:'text'}]);

// === FIX 37: Add "پودر دستی" to laundry-powder ===
const lp = find('laundry-powder');
if (lp) {
  if (!lp.keywords.includes('پودر دستی')) lp.keywords.push('پودر دستی');
  if (!lp.aliases.includes('پودر لباسشویی دستی')) lp.aliases.push('پودر لباسشویی دستی');
  if (!lp.aliases.includes('پودر رختشویی')) lp.aliases.push('پودر رختشویی');
}

// === FIX 38: Add "روغن موتور" as new good (automotive, not in current catalog) ===
add('motor-oil','روغن موتور','Motor Oil',
  ['روغن موتور','روغن خودرو','روغن بنزینی','روغن دیزل'],
  ['روغن موتور','روغن خودرو'],
  ['خوراکی','زیتون','سویا','آفتابگردان','کنجد','نارگیل','کرچک','کودکان','بدن'],
  [],
  '10002670','2710','LITER','automotive',
  [{key:'viscosity',fa:'گرانروی',type:'enum',options:['20W50','10W40','5W30','15W40']},{key:'volume_ml',fa:'حجم',type:'text'}]);

// === FIX 39: Add "فوم اصلاح" to razor ===
const rz2 = find('razor-shaving-gel');
if (rz2) {
  if (!rz2.keywords.includes('فوم اصلاح')) rz2.keywords.push('فوم اصلاح');
  if (!rz2.keywords.includes('فوم اصالح')) rz2.keywords.push('فوم اصالح');
}

// === FIX 40: Add "ماست چکیده موسیر" as alias to yogurt-flavored ===
const yf = find('yogurt-flavored-vegetable');
if (yf) {
  if (!yf.aliases.includes('ماست چکیده موسیر')) yf.aliases.push('ماست چکیده موسیر');
  if (!yf.aliases.includes('ماست موسیر')) yf.aliases.push('ماست موسیر');
  if (!yf.aliases.includes('ماست بادمجان')) yf.aliases.push('ماست بادمجان');
  if (!yf.aliases.includes('ماست خیار')) yf.aliases.push('ماست خیار');
}

// === FIX 41: Add "آلبالو" (fresh sour cherry) and "قیسی" (dried apricot) ===
// These should match existing goods but need better keywords
const sc2 = find('sour-cherry-fresh');
if (sc2) {
  if (!sc2.keywords.includes('آلبالو')) sc2.keywords.push('آلبالو');
  if (!sc2.aliases.includes('آلبالو تازه')) sc2.aliases.push('آلبالو تازه');
}
const da = find('dried-apricot-berge');
if (da) {
  if (!da.aliases.includes('قیسی')) da.aliases.push('قیسی');
  if (!da.aliases.includes('برگه زردآلو')) da.aliases.push('برگه زردآلو');
}

// === FIX 42: Add "ذرت" (corn) — fresh or canned ===
add('corn-canned-fresh','ذرت کنسروی و تازه','Corn',
  ['ذرت','ذرت شیرین','ذرت کنسروی'],
  ['ذرت'],
  ['آرد ذرت','نشاسته ذرت','کرن فلور','روغن ذرت'],
  [],
  '50202495','1005','CARTON','fresh-produce',
  [{key:'form',fa:'نوع',type:'enum',options:['تازه','کنسروی','منجمد']}]);


// === FIX 43: Improve "نوشیدنی ورزشی" matching ===
const sd = find('sports-drink');
if (sd) {
  if (!sd.keywords.includes('نوشابه انرژی')) sd.keywords.push('نوشابه انرژی');
  if (!sd.keywords.includes('نوشابه انرژی زا')) sd.keywords.push('نوشابه انرژی زا');
}

// Save
catalog._total_goods = catalog.goods.length;
fs.writeFileSync('/home/z/imach-back/local-data/reference/reference-catalog-v3.json', JSON.stringify(catalog, null, 2));
console.log('Catalog patched. Total goods:', catalog.goods.length);
