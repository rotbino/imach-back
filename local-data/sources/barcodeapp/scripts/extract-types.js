const { MongoClient } = require('mongodb');
const uri = "mongodb://uniqu434343:MirAli%40434343%2A@megancluster-shard-00-00.jm46r.mongodb.net:27017,megancluster-shard-00-01.jm46r.mongodb.net:27017,megancluster-shard-00-02.jm46r.mongodb.net:27017/imach_online_db?ssl=true&replicaSet=atlas-10bcqm-shard-0&authSource=admin&appName=MeganCluster";

function normalizeFa(text) {
  if (!text) return "";
  return text
    .replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 0x0030))
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x0030))
    .replace(/ي/g, "ی").replace(/ك/g, "ک")
    .replace(/أ|إ|آ/g, "ا").replace(/ة/g, "ه")
    .replace(/ؤ/g, "و").replace(/ئ/g, "ی")
    .replace(/\u200c/g, " ")
    .toLowerCase().trim();
}

async function main() {
  const c = new MongoClient(uri); await c.connect();
  const db = c.db('imach_online_db');

  const cats = await db.collection('Category').find({ parentId: null }).toArray();
  
  for (const cat of cats) {
    // Get all descendant categories
    const allCats = await db.collection('Category').find({}).toArray();
    const stack = [cat._id.toString()];
    const catIds = [];
    while (stack.length) {
      const id = stack.pop();
      catIds.push(id);
      for (const cc of allCats) {
        if (cc.parentId && cc.parentId.toString() === id) stack.push(cc._id.toString());
      }
    }
    const objIds = catIds.map(id => allCats.find(x => x._id.toString() === id)._id);
    
    // Get products in this category subtree
    const goods = await db.collection('Good').find({ categoryId: { $in: objIds } }).toArray();
    if (goods.length === 0) continue;
    const goodIds = goods.map(g => g._id);
    const productCount = await db.collection('Product').countDocuments({ goodId: { $in: goodIds } });
    if (productCount === 0) continue;
    
    console.log('\n\n=========================================');
    console.log('=== ' + cat.nameFa + ' (' + cat.slug + ') - ' + productCount + ' products ===');
    console.log('=========================================');
    
    // Get all product labels and extract the "type" patterns
    const products = await db.collection('Product').find({ goodId: { $in: goodIds } })
      .project({ label: 1, 'metadata.clean_name': 1, 'metadata.barcodeapp_subcategory': 1 })
      .limit(2000)
      .toArray();
    
    // Group by clean_name (this is the "type" that barcodeapp already identified)
    const byCleanName = new Map();
    for (const p of products) {
      const cn = p.metadata?.clean_name || p.label;
      if (!cn) continue;
      const norm = normalizeFa(cn);
      if (!byCleanName.has(norm)) byCleanName.set(norm, { count: 0, samples: [], original: cn });
      const entry = byCleanName.get(norm);
      entry.count++;
      if (entry.samples.length < 3) entry.samples.push(p.label);
    }
    
    // Sort by count desc and show top 50
    const sorted = [...byCleanName.entries()].sort((a, b) => b[1].count - a[1].count);
    console.log('\nTop clean_names (types) - showing ' + Math.min(sorted.length, 50) + ' of ' + sorted.length + ':');
    for (const [norm, info] of sorted.slice(0, 50)) {
      console.log('  [' + info.count + '] ' + info.original);
      if (info.samples.length > 0 && info.count <= 3) {
        info.samples.forEach(s => console.log('       e.g., ' + s));
      }
    }
  }
  
  await c.close();
}
main();
