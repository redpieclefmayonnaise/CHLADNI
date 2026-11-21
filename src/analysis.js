import { modeForFrequency, modesFromPeaks, peaksFromSpectrum, MODES } from './chladni.js';

export function fft(re, im) {
  const n = re.length;
  for (let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
  for(let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wlr=Math.cos(ang),wli=Math.sin(ang);for(let i=0;i<n;i+=len){let wr=1,wi=0;for(let j=0;j<len/2;j++){const u=i+j,v=u+len/2,tr=wr*re[v]-wi*im[v],ti=wr*im[v]+wi*re[v];re[v]=re[u]-tr;im[v]=im[u]-ti;re[u]+=tr;im[u]+=ti;const nw=wr*wlr-wi*wli;wi=wr*wli+wi*wlr;wr=nw;}}}
}
const band = (magnitudes, rate, lo, hi) => { const a=Math.max(1,Math.floor(lo*4096/rate)),b=Math.min(magnitudes.length-1,Math.ceil(hi*4096/rate));let s=0,c=0;for(let i=a;i<=b;i++){s+=magnitudes[i];c++;}return c?s/c:0; };

export async function analyzeAudioBuffer(buffer, onProgress = () => {}) {
  const channelCount=buffer.numberOfChannels, length=buffer.length, rate=buffer.sampleRate;
  const channels=Array.from({length:channelCount},(_,c)=>buffer.getChannelData(c));
  const size=4096, hop=Math.max(1024,Math.floor(rate*.125)), total=Math.max(1,Math.ceil((length-size)/hop)+1), out=[];
  const re=new Float32Array(size), im=new Float32Array(size), mags=new Float32Array(size/2);
  const window=new Float32Array(size);
  for(let i=0;i<size;i++)window[i]=.5-.5*Math.cos(2*Math.PI*i/(size-1));
  for(let frame=0;frame<total;frame++){
    const start=frame*hop; let rms=0;
    for(let i=0;i<size;i++){const at=Math.min(length-1,start+i);let s=0;for(let c=0;c<channelCount;c++)s+=channels[c][at]||0;s/=channelCount;rms+=s*s;re[i]=s*window[i];im[i]=0;}
    fft(re,im);let centroid=0,weight=0,peak=0,peakBin=1;
    for(let i=1;i<mags.length;i++){mags[i]=Math.hypot(re[i],im[i]);const hz=i*rate/size;centroid+=hz*mags[i];weight+=mags[i];if(mags[i]>peak){peak=mags[i];peakBin=i;}}
    const bass=band(mags,rate,30,250), mid=band(mags,rate,250,2000), high=band(mags,rate,2000,10000);
    const centroidHz=weight?centroid/weight:0, peakHz=peakBin*rate/size;
    const spectralPeaks=peaksFromSpectrum(mags,rate,size), modes=modesFromPeaks(spectralPeaks);
    const modal=modes[0] ? MODES[modes[0].modeIndex] : modeForFrequency(peakHz);
    out.push({energy:Math.min(1,Math.sqrt(rms/size)*5), centroid:centroidHz, peak:peakHz, bass,mid,high,m:modal.m,n:modal.n,modeIndex:MODES.indexOf(modal),spectralPeaks,modes});
    if(frame%12===0){onProgress(frame/total);await new Promise(r=>setTimeout(r,0));}
  }
  onProgress(1);
  return out;
}
