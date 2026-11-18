// Supabase Edge Function: analyze-meal
// Deploy with: supabase functions deploy analyze-meal
// Set secret with: supabase secrets set OPENAI_API_KEY=...
// Requires a valid Supabase user JWT. Never expose the OpenAI key in the browser.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
Deno.serve(async (req) => {
 const headers={'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
 const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{headers});
 if(req.method!=='POST')return respond({error:'Method not allowed'},405);
 try{
  const auth=req.headers.get('Authorization')||'';
  if(!auth.startsWith('Bearer '))return respond({error:'Unauthorized'},401);
  const supabase=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
  const {data:{user},error:authError}=await supabase.auth.getUser();
  if(authError||!user)return respond({error:'Unauthorized'},401);
  const {image}=await req.json();
  if(typeof image!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)||image.length>2500000)return respond({error:'Invalid or oversized image'},400);
  const key=Deno.env.get('OPENAI_API_KEY');
  if(!key)return respond({error:'AI service not configured'},503);
  const ai=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',temperature:0.2,response_format:{type:'json_object'},messages:[{role:'system',content:'You are a Vietnamese food calorie estimation assistant. Analyze the image and output ONLY JSON: {"items":[{"name":"Vietnamese food name","grams":150,"kcal100":130}]}. Estimate cooked edible grams and kcal per 100g for each visibly distinct food item, including obvious sauces/oils when possible. Maximum 12 items. If uncertain, make conservative approximate estimates. Never claim precision. If no food, return {"items":[]}. No other fields.'},{role:'user',content:[{type:'text',text:'Identify all foods and estimate calories for this meal. Use Vietnamese names.'},{type:'image_url',image_url:{url:image,detail:'low'}}]}]})});
  if(!ai.ok)return respond({error:'AI provider unavailable'},502);
  const json=await ai.json();let result;
  try{result=JSON.parse(json.choices?.[0]?.message?.content||'{}')}catch{return respond({error:'Invalid AI response'},502)}
  const items=Array.isArray(result.items)?result.items.slice(0,12).map((x:Record<string,unknown>)=>({name:String(x.name||'').slice(0,120),grams:Math.round(Number(x.grams)||0),kcal100:Math.round((Number(x.kcal100)||0)*10)/10})).filter((x:{name:string,grams:number,kcal100:number})=>x.name&&x.grams>0&&x.grams<=10000&&x.kcal100>=0&&x.kcal100<=1000):[];
  return respond({items,notice:'Ước tính từ ảnh, cần xác nhận khối lượng và cách chế biến trước khi lưu.'});
 }catch{return respond({error:'Could not analyze image'},500)}
});
