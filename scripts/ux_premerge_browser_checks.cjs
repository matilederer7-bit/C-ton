// Additional rendered acceptance for the pre-financial UX candidate.
module.exports = async ({ev,send,show,wait,waitFor,viewport,shot,check,assert,eq,WIDTHS,HEIGHTS,DEAL_ID,PROFILE_ID}) => {
  const setInput = async (selector,value) => {
    await ev(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(100);
  };
  const overflow = async name => {
    const result = await ev(`({width:innerWidth,html:document.documentElement.scrollWidth,body:document.body.scrollWidth,heading:document.querySelector('h1,h2,h3,.panel-title')?.textContent,offenders:[...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left< -1||r.right>innerWidth+1)}).slice(0,5).map(e=>e.className)})`);
    assert(result.html<=result.width && result.body<=result.width,`${name}: ${JSON.stringify(result)}`);
    assert(result.heading,`${name}: no rendered heading`);
  };
  const reset = () => ev(`Object.assign(window.fixtureState,{pickup:null,entitlement:undefined,seller:null,failure:false,empty:false})`);
  for (const width of WIDTHS) {
    await viewport(width,HEIGHTS[width]);
    await reset();
    await show('deal');
    await ev('window.scrollTo(0,0)'); await wait(250);
    await check(`PREMERGE @${width}: early CTA visible, same join sheet, no obstruction`,async()=>{
      const r=await ev(`(()=>{const e=document.querySelector('[data-testid="join-open-summary"]');const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,h:innerHeight,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),canonical:!!document.querySelector('[data-testid="join-open"]'),price:e.parentElement.textContent};})()`);
      assert(r.top>=0&&r.bottom<r.h,JSON.stringify(r)); assert(r.hit,'CTA obscured'); assert(r.canonical,'canonical order CTA missing'); assert(r.price.includes('89')&&r.price.includes('18'),'price/threshold missing');
      await ev(`document.querySelector('[data-testid="join-open-summary"]').click()`); await waitFor(`!!document.querySelector('#join-form')`);
      await overflow('join sheet');
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',modifiers:8});
      assert(await ev(`document.querySelector('[role="dialog"]').contains(document.activeElement)`),'Shift-Tab escaped dialog');
      await ev(`document.querySelector('.modal .x').click()`); await wait(100);
    });
    await check(`PREMERGE @${width}: invalid quantities cannot silently submit previous value`,async()=>{
      for (const input of ['','0','1.5','-2','1e2','999999999999999999']) {
        await setInput('[data-testid="join-qty"]',input);
        await ev(`document.querySelector('[data-testid="join-open-summary"]').click()`); await wait(80);
        assert(!await ev(`!!document.querySelector('#join-form')`),`invalid quantity opened join: ${input}`);
      }
      await setInput('[data-testid="join-qty"]','2');
      await ev(`document.querySelector('[data-testid="join-open"]').click()`); await waitFor(`!!document.querySelector('#join-form')`);
      await ev(`document.querySelector('.modal .x').click()`); await wait(100);
    });
    await check(`PREMERGE @${width}: all pilot disclosures retain copy without decorative glyph`,async()=>{
      assert(await ev(`[...document.querySelectorAll('[data-testid="pilot-line"]')].every(e=>e.textContent.includes('פיילוט')&&!e.textContent.includes('🧪'))`),'pilot glyph or missing copy');
    });
    await check(`PREMERGE @${width}: share URLs, copy action and circular control parity`,async()=>{
      const links=await ev(`[...document.querySelectorAll('.share-networks a')].map(a=>a.href)`);
      assert(links.length>=4,'missing share links');
      for(const link of links) assert(decodeURIComponent(link).includes('/d/'+DEAL_ID),'share link lost canonical deal URL');
      await ev(`window.__copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}});document.querySelector('[data-testid="share-copy"]').click()`);await wait(100);
      assert((await ev('window.__copied')).includes('/d/'+DEAL_ID),'copy did not receive canonical URL');
      const styles=await ev(`[...document.querySelectorAll('.share-actions.compact .share-ico-btn')].map(e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect();return [c.backgroundColor,c.borderRadius,r.width,r.height]})`);
      assert(styles.length>=6,'copy should use same visual control');
      assert(styles.every(s=>JSON.stringify(s)===JSON.stringify(styles[0])),'copy/network circles differ');
    });
    for (const state of ['payment_pending','deal_failed','unavailable','ready']) {
      await show('receipt'); // unmount so fixture reads are fresh
      await ev(`window.fixtureState.pickup={applicable:true,state:${JSON.stringify(state)},method:'pickup',headline:'התשלום עדיין לא הושלם',subline:'ההזמנה עדיין אינה מוכנה למסירה',qty:2,order_code:'PICKUP-SECRET',qr_payload:'PICKUP-QR-SECRET',product_title:'מארז'};window.fixtureState.entitlement={ok:true,configured:false,entitlement:${state==='ready' ? "{status:'valid',method:'code',code:'RECEIPT-SECRET',quantity:2}" : 'null'}}`);
      await show('entitlement');
      await check(`PREMERGE @${width}: pickup ${state} visible and credential eligibility retained`,async()=>{
        await waitFor(`!!document.querySelector('[data-testid="track-pickup"]')`);
        eq(await ev(`document.querySelector('[data-testid="track-pickup"]').dataset.state`),state,'pickup state');
        if(state==='ready') assert(await ev(`document.body.textContent.includes('PICKUP-SECRET')&&!!document.querySelector('[data-testid="pickup-fullscreen-open"]')`),'paid pickup missing credential');
        else assert(await ev(`!document.body.innerHTML.includes('PICKUP-SECRET')&&!document.body.innerHTML.includes('PICKUP-QR-SECRET')&&!document.querySelector('.receipt-code,[data-testid="pickup-code"],.pickup-fullscreen')`),'ineligible buyer exposed redeem credential');
        await overflow(`pickup ${state}`);
      });
    }
    await check(`PREMERGE @${width}: pickup fullscreen keyboard containment and return`,async()=>{
      await ev(`document.querySelector('[data-testid="pickup-fullscreen-open"]').focus();document.activeElement.click()`);await wait(100);
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'});
      assert(await ev(`document.querySelector('[data-testid="pickup-fullscreen"]').contains(document.activeElement)`),'focus escaped pickup');
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await wait(100);
      assert(await ev(`document.activeElement.dataset.testid==='pickup-fullscreen-open'`),'pickup trigger focus not restored');
    });
    await reset();
    for(const view of ['mall','track','seller','edit','onboarding','receipts','pickup','handoff','cms','admin']) {
      await show(view,300);
      await check(`PREMERGE @${width}: rendered ${view} has no horizontal overflow`,()=>overflow(view));
      if(width===390||width===1280) await shot(`sweep-${view}-${width}`);
    }
    for(const variant of ['empty','long-he','long-en']) {
      await show('receipt');
      await ev(`window.fixtureState.seller={...window.fixtureSeller,image:null,about:${variant==='empty'?"''":JSON.stringify((variant==='long-he'?'תיאורעבריארוך':'LongEnglishDescription').repeat(40))},name:${JSON.stringify((variant==='long-he'?'שםמוכרארוך':'LongSellerName').repeat(15))},email:'PRIVATE-EMAIL',phone:'PRIVATE-PHONE',seller_id:'PRIVATE-ID',bank:'PRIVATE-BANK',admin_notes:'PRIVATE-NOTES'}`);
      await show('profile');
      await check(`PREMERGE @${width}: seller profile ${variant} wraps and ignores private keys`,async()=>{await overflow('seller profile');assert(await ev(`!document.body.textContent.includes('PRIVATE-')&&!document.querySelector('[data-testid="seller-profile-image"]')`),'private fields leaked or absent image broken');});
    }
    await reset();
    for(const route of ['#/content/legal_terms','#/content/legal_privacy','#/content/legal_refunds','#/admin']) {
      await show(route,300);
      await check(`PREMERGE @${width}: native app shell ${route}`,async()=>{
        await overflow(route);
        if(route.includes('content')) assert(await ev(`!!document.querySelector('header')&&!!document.querySelector('footer')&&!!document.querySelector('.content-doc')`),'document detached from app shell');
        else assert(await ev(`!!document.querySelector('[data-testid="admin-stepup"]')`),'direct admin link bypassed step-up');
      });
    }
    await reset();
    await ev('window.fixtureState.empty=true');
    for(const view of ['mall','cms']) {await show(view);await check(`PREMERGE @${width}: ${view} empty state`,()=>overflow(view));}
    await reset();
    await ev('window.fixtureState.failure=true');
    for(const view of ['deal','track','profile']) {await show(view);await check(`PREMERGE @${width}: ${view} failure state`,()=>overflow(view));}
    await reset();
  }
  await viewport(390,844);
  await show('profile-edit');
  await check('PREMERGE: profile name receives exact attention and clears immediately',async()=>{
    await setInput('#f-public-name','');await ev(`document.querySelector('form').requestSubmit()`);await wait(100);
    assert(await ev(`document.activeElement.id==='f-public-name'&&document.activeElement.getAttribute('aria-invalid')==='true'`),'missing profile name not targeted');
    await setInput('#f-public-name','מ');eq(await ev(`document.querySelector('#f-public-name').getAttribute('aria-invalid')`),null,'valid name did not clear');
  });
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await show('wizard');await ev(`[...document.querySelectorAll('button')].find(b=>/המשך|הבא/.test(b.textContent)).click()`);await wait(200);
  await check('PREMERGE: reduced motion uses static field attention',async()=>eq(await ev(`getComputedStyle(document.querySelector('#f-title')).animationName`),'none','reduced motion animation'));
  await send('Emulation.setEmulatedMedia',{features:[]});
  await reset();
  await show('edit');
  await check('PREMERGE: delivery edit targets missing labels and clears on valid input',async()=>{
    await ev(`document.querySelector('[data-testid="delivery-edit-open"]').click()`);await wait(100);
    for(const selector of ['#f-delivery-label-0','#f-delivery-label-1']) await setInput(selector,'');
    await ev(`document.querySelector('[data-testid="delivery-save"]').click()`);await wait(100);
    assert(await ev(`document.activeElement.id==='f-delivery-label-0'&&document.activeElement.getAttribute('aria-invalid')==='true'`),'delivery label not targeted');
    await setInput('#f-delivery-label-0','הרצל 12');
    eq(await ev(`document.querySelector('#f-delivery-label-0').getAttribute('aria-invalid')`),null,'delivery attention did not clear');
  });
  await check('PREMERGE: publish targets consent checkboxes without publishing',async()=>{
    await ev(`document.querySelector('[data-testid="publish-open"]').click()`);await wait(100);
    await ev(`document.querySelector('[data-testid="publish-confirm"]').click()`);await wait(100);
    assert(await ev(`document.activeElement.id==='f-publish-terms'&&document.activeElement.getAttribute('aria-invalid')==='true'`),'publish consent not targeted');
    await ev(`document.querySelector('#f-publish-terms').click()`);await wait(100);
    eq(await ev(`document.querySelector('#f-publish-terms').getAttribute('aria-invalid')`),null,'consent attention did not clear');
    assert(await ev(`document.querySelector('#f-publish-threshold').getAttribute('aria-invalid')==='true'`),'remaining consent must stay marked');
    await ev(`document.querySelector('.modal .x').click()`);await wait(100);
  });
  await show('#/content/missing-document');
  await check('PREMERGE: missing CMS page finishes loading with a native empty state',async()=>assert(await ev(`document.querySelector('.content-doc').textContent.includes('אינו זמין')`),'missing document stuck loading'));
  await check('PREMERGE: complete wizard attention includes typed quantities and receipt control',async()=>{
    await show('wizard');
    await setInput('#f-title','מארז');await setInput('#f-short','מארז בדיקה');await setInput('#f-price','89');
    const {root}=await send('DOM.getDocument');
    const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type="file"]'});
    await send('DOM.setFileInputFiles',{nodeId,files:[require('path').resolve('web/public/brand/c-ton-mark-180.png')]});
    await waitFor(`!!document.querySelector('.img-card')`);
    await ev(`[...document.querySelectorAll('button')].find(b=>/המשך|הבא/.test(b.textContent)).click()`);await waitFor(`!!document.querySelector('#f-min')`);
    await setInput('#f-min','');await ev(`[...document.querySelectorAll('button')].find(b=>/המשך|הבא/.test(b.textContent)).click()`);await wait(120);
    assert(await ev(`document.querySelector('#f-min').getAttribute('aria-invalid')==='true'&&document.activeElement.id==='f-min'`),'seller quantity missing attention');
    await setInput('#f-min','5');await setInput('#f-max','20');
    eq(await ev(`document.querySelector('#f-min').getAttribute('aria-invalid')`),null,'seller quantity attention did not clear');
    await ev(`[...document.querySelectorAll('button')].find(b=>/המשך|הבא/.test(b.textContent)).click()`);await waitFor(`!!document.querySelector('.receipt-fields')`);
    await ev(`document.querySelectorAll('[data-testid="receipt-method-option"] input')[4].click()`);await wait(100);
    await ev(`[...document.querySelectorAll('button')].find(b=>/המשך|הבא/.test(b.textContent)).click()`);await wait(100);
    assert(await ev(`document.querySelector('textarea#f-receipt')?.getAttribute('aria-invalid')==='true'`),'receipt instructions must target exact textarea');
    await setInput('textarea#f-receipt','מ');
    assert(await ev(`!document.querySelector('.receipt-fields .needs-attention')`),'receipt attention did not clear');
  });
  await show('app');
  await check('PREMERGE: current brand and hidden admin entry contract',async()=>{
    assert(await ev(`document.body.textContent.includes('C-ton (סיטון)')`),'intentional current bilingual brand missing');
    assert(await ev(`!!document.querySelector('[data-testid="admin-hotspot"]')&&!document.querySelector('nav a[href="#/admin"]')`),'hidden admin entry contract changed');
    await show('#/admin');
    assert(await ev(`!!document.querySelector('[data-testid="admin-stepup"]')&&!document.body.textContent.includes('תמונת מצב — כל המערכת')`),'admin password step bypassed');
  });
  // Reload enables the real Mall feature flag; history checks use real App
  // routing, hash links and browser traversal, never a simulated scroll model.
  await check('PREMERGE: no console errors before navigation reload',async()=>eq(await ev('window.__consoleErrors'),[],'console errors'));
  const origin=await ev('location.origin');
  await send('Page.navigate',{url:origin+'/?mall=1'});await waitFor(`!!document.querySelector('.card')`);
  await check('PREMERGE: Mall → deal → back/forward restores separate entries',async()=>{
    await ev('window.scrollTo(0,600)');await wait(350);const y=await ev('scrollY');assert(y>100,'Mall must be scrollable');
    await ev(`document.querySelector('.card').click()`);await waitFor(`!!document.querySelector('[data-testid="join-open-summary"]')`);await wait(400);
    await ev('window.scrollTo(0,900)');await wait(350);const dealY=await ev('scrollY');
    await ev('history.back()');await waitFor(`!!document.querySelector('.card')`);await wait(550);
    assert(Math.abs(await ev('scrollY')-y)<5,`Mall position was not restored: expected=${y}, actual=${await ev('scrollY')}, store=${await ev('sessionStorage.getItem("siton_scroll_positions_v1")')}`);
    await ev('history.forward()');await waitFor(`!!document.querySelector('[data-testid="join-open-summary"]')`);await wait(550);
    assert(Math.abs(await ev('scrollY')-dealY)<5,'deal position was not restored');
  });
  await check('PREMERGE: deal → seller profile and legal → back restores position',async()=>{
    await show(`#/deal/${DEAL_ID}`);await waitFor(`!!document.querySelector('[data-testid="join-open-summary"]')`);await wait(400);
    for(const target of [`#/public-seller/${PROFILE_ID}`,'#/content/legal_terms']) {
      await ev('window.scrollTo(0,700)');await wait(350);const y=await ev('scrollY');
      await ev(`document.querySelector('a[href="${target}"]').click()`);await wait(650);
      assert(await ev(`location.hash===${JSON.stringify(target)}`),'link did not navigate');
      await ev('history.back()');await waitFor(`!!document.querySelector('[data-testid="join-open-summary"]')`);await wait(600);
      assert(Math.abs(await ev('scrollY')-y)<5,`${target} back position lost`);
    }
  });
  await check('PREMERGE: seller dashboard → draft editor → back restores position',async()=>{
    await ev(`location.hash='#/seller'`);await waitFor(`!!document.querySelector('.dash-head')`);await wait(500);
    await ev('window.scrollTo(0,250)');await wait(350);const y=await ev('scrollY');
    await ev(`location.hash='#/seller/deal/${DEAL_ID}'`);await waitFor(`!!document.querySelector('[data-testid="draft-edit-open"]')`);
    await ev(`document.querySelector('[data-testid="draft-edit-open"]').click()`);await waitFor(`!!document.querySelector('#f-title')`);
    await setInput('#f-title','');await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('שמירת השינויים')).click()`);await wait(150);
    assert(await ev(`document.querySelector('#f-title').getAttribute('aria-invalid')==='true'`),'draft title was not targeted');
    await ev('history.back()');await waitFor(`!!document.querySelector('.dash-head')`);await wait(600);
    assert(Math.abs(await ev('scrollY')-y)<5,`seller dashboard position lost: expected=${y}, actual=${await ev('scrollY')}, store=${await ev('sessionStorage.getItem("siton_scroll_positions_v1")')}`);
  });
};
