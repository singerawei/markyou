import { diagram,highlight } from './diagrams';
(window as any).renderExport = async (allowMissing=false) => {
  for (const code of document.querySelectorAll<HTMLElement>('pre > code')) {
    const language = [...code.classList].find(name=>name.startsWith('language-'))?.slice(9) ?? '';
    if (language === 'mermaid') { const figure=document.createElement('figure');try{figure.innerHTML=await diagram(code.textContent ?? '');}catch(error){if(!allowMissing)throw error;figure.textContent='Diagram error: '+String(error)+'\n'+code.textContent;}code.parentElement!.replaceWith(figure); }
    else code.innerHTML=highlight(code.textContent ?? '',language);
  }
};
