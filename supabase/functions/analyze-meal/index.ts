// Supabase Edge Function: analyze-meal
// Deploy with: supabase functions deploy analyze-meal
// Set secret with: supabase secrets set GEMINI_API_KEY=...
// Requires a valid Supabase user JWT. Never expose the Gemini key in the browser.
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
  const key=Deno.env.get('GEMINI_API_KEY');
  if(!key)return respond({error:'Gemini service not configured'},503);
  const prompt='Analyze this photo of a meal. Return ONLY a JSON object with items array, each item having name (Vietnamese food name), grams (estimated cooked edible grams), kcal100 (estimated kcal per 100g). Up to 12 separate foods. Include visible sauces and oil when possible. Be conservative, never claim precision. If no food return {"items":[]}. Example: {"items":[{"name":"Cơm trắng","grams":150,"kcal100":130}]}';
  // Discover the models actually available to this Gemini API key.
  // A fixed model name may return 404 even when the key is valid.
  const available=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',{
   headers:{'x-goog-api-key':key}
  });
  if(!available.ok){
   const err=await available.json().catch(()=>({}));
   return respond({error:'Gemini model list failed (HTTP '+available.status+'): '+String(err?.error?.message||'Please check API key and project').slice(0,240)},502);
  }
  const catalog=await available.json();
  const supported=(Array.isArray(catalog.models)?catalog.models:[])
   .filter((m:{name?:string,supportedGenerationMethods?:string[]})=>m.name?.startsWith('models/gemini-')&&m.supportedGenerationMethods?.includes('generateContent'))
   .map((m:{name:string})=>m.name);
  // Exclude audio/TTS/live/embedding models; generateContent alone does not imply image support.
  const imageModels=supported.filter((n:string)=>/gemini-(?:2[.]5|2[.]0|3(?:[.]|-))/i.test(n)&&/flash/i.test(n)&&!/tts|audio|live|native|embedding|computer|image-generation/i.test(n));
  const priority=['models/gemini-2.5-flash-lite','models/gemini-2.5-flash','models/gemini-2.0-flash-lite','models/gemini-2.0-flash'];
  const ordered=[...priority.filter(n=>imageModels.includes(n)),...imageModels.filter((n:string)=>!priority.includes(n))].slice(0,6);
  if(!ordered.length)return respond({error:'No Gemini Flash model with generateContent is available for this API key.'},502);
  const requestBody=JSON.stringify({contents:[{parts:[{text:prompt},{inline_data:{mime_type:'image/jpeg',data:image.split(',')[1]}}]}],generationConfig:{responseMimeType:'application/json',temperature:0.2}});
  let result:Record<string,unknown>|null=null,lastError='';
  for(const model of ordered){
   const ai=await fetch('https://generativelanguage.googleapis.com/v1beta/'+model+':generateContent',{
    method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:requestBody
   });
   if(!ai.ok){
    const err=await ai.json().catch(()=>({}));
    lastError=model+' HTTP '+ai.status+': '+String(err?.error?.message||'Request failed').slice(0,220);
    // Do not retry rate limits, auth failures or other errors on multiple models.
    if(ai.status!==404 && !(ai.status===400 && /image input modality|does not support image|image is not supported/i.test(String(err?.error?.message||''))))break;
    continue;
   }
   const json=await ai.json();
   try{result=JSON.parse(json.candidates?.[0]?.content?.parts?.map((p:{text?:string})=>p.text||'').join('')||'{}')}
   catch{return respond({error:'Gemini returned an invalid JSON response'},502)}
   break;
  }
  if(!result)return respond({error:'Gemini request failed: '+lastError},502);
  const items=Array.isArray(result.items)?result.items.slice(0,12).map((x:Record<string,unknown>)=>({name:String(x.name||'').slice(0,120),grams:Math.round(Number(x.grams)||0),kcal100:Math.round((Number(x.kcal100)||0)*10)/10})).filter((x:{name:string,grams:number,kcal100:number})=>x.name&&x.grams>0&&x.grams<=10000&&x.kcal100>=0&&x.kcal100<=1000):[];
  return respond({items,notice:'Ước tính từ ảnh, cần xác nhận khối lượng và cách chế biến trước khi lưu.'});
 }catch{return respond({error:'Could not analyze image'},500)}
});
