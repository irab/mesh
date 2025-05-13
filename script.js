document.addEventListener('DOMContentLoaded', function() {
    // Accordion functionality
    const accordionItems = document.querySelectorAll('.accordion-item');
    
    accordionItems.forEach(item => {
        const header = item.querySelector('.accordion-header');
        
        header.addEventListener('click', () => {
            // Close all other items
            accordionItems.forEach(otherItem => {
                if (otherItem !== item && otherItem.classList.contains('active')) {
                    otherItem.classList.remove('active');
                    const icon = otherItem.querySelector('.accordion-icon');
                    icon.textContent = '+';
                }
            });
            
            // Toggle the clicked item
            item.classList.toggle('active');
            const icon = item.querySelector('.accordion-icon');
            icon.textContent = item.classList.contains('active') ? '×' : '+';
        });
    });

    // Navigation active state based on scroll position
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('nav a');
    
    if (sections.length > 0 && navLinks.length > 0) {
        window.addEventListener('scroll', () => {
            let current = '';
            const scrollY = window.pageYOffset;
            
            sections.forEach(section => {
                const sectionTop = section.offsetTop - 100;
                const sectionHeight = section.offsetHeight;
                
                if (scrollY >= sectionTop && scrollY < sectionTop + sectionHeight) {
                    current = section.getAttribute('id');
                }
            });
            
            navLinks.forEach(link => {
                link.classList.remove('active');
                if (link.getAttribute('href') === `#${current}` || 
                    (current === '' && link.getAttribute('href') === '#overview')) {
                    link.classList.add('active');
                }
            });
        });
    }

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            
            if (href !== '#') {
                e.preventDefault();
                
                const targetElement = document.querySelector(href);
                if (targetElement) {
                    window.scrollTo({
                        top: targetElement.offsetTop - 70,
                        behavior: 'smooth'
                    });
                }
            }
        });
    });
    
    // Routing diagram animation interaction
    const routingDiagram = document.querySelector('.routing-diagram');
    if (routingDiagram) {
        const meshtasticParticle = document.querySelector('.meshtastic-particle');
        const meshtasticParticle2 = document.querySelector('.meshtastic-particle-2');
        const meshtasticParticle3 = document.querySelector('.meshtastic-particle-3');
        
        // MeshCore elements
        const meshcoreFlood1 = document.querySelector('.meshcore-flood-1');
        const meshcoreFlood2 = document.querySelector('.meshcore-flood-2');
        const meshcoreFlood3 = document.querySelector('.meshcore-flood-3');
        const meshcoreDirectPacket = document.querySelector('.meshcore-direct-packet');
        const meshcoreDropped1 = document.querySelector('.meshcore-dropped-1');
        const meshcoreDropped2 = document.querySelector('.meshcore-dropped-2');
        const routeLinkAC = document.querySelector('.a-to-c');
        const routeLinkCE = document.querySelector('.c-to-e');
        const phase1Text = document.querySelector('.phase-1');
        const phase2Text = document.querySelector('.phase-2');
        const phase3Text = document.querySelector('.phase-3');
        
        // Reset Meshtastic animations
        const resetMeshtasticAnimations = () => {
            if (meshtasticParticle) {
                meshtasticParticle.style.animation = 'none';
                setTimeout(() => {
                    meshtasticParticle.style.animation = 'meshtastic-routing 5s infinite';
                }, 10);
            }
            
            if (meshtasticParticle2) {
                meshtasticParticle2.style.animation = 'none';
                setTimeout(() => {
                    meshtasticParticle2.style.animation = 'meshtastic-routing-2 5s infinite';
                    meshtasticParticle2.style.animationDelay = '0.7s';
                }, 10);
            }
            
            if (meshtasticParticle3) {
                meshtasticParticle3.style.animation = 'none';
                setTimeout(() => {
                    meshtasticParticle3.style.animation = 'meshtastic-routing-3 5s infinite';
                    meshtasticParticle3.style.animationDelay = '1.4s';
                }, 10);
            }
        };
        
        // Reset MeshCore animations
        const resetMeshcoreAnimations = () => {
            if (meshcoreFlood1) {
                meshcoreFlood1.style.animation = 'none';
                setTimeout(() => {
                    meshcoreFlood1.style.animation = 'meshcore-flood-1 15s forwards';
                }, 10);
            }
            
            if (meshcoreFlood2) {
                meshcoreFlood2.style.animation = 'none';
                setTimeout(() => {
                    meshcoreFlood2.style.animation = 'meshcore-flood-2 15s forwards';
                }, 10);
            }
            
            if (meshcoreFlood3) {
                meshcoreFlood3.style.animation = 'none';
                setTimeout(() => {
                    meshcoreFlood3.style.animation = 'meshcore-flood-3 15s forwards';
                }, 10);
            }
            
            if (meshcoreDirectPacket) {
                meshcoreDirectPacket.style.animation = 'none';
                setTimeout(() => {
                    meshcoreDirectPacket.style.animation = 'meshcore-direct 15s infinite';
                }, 10);
            }
            
            if (meshcoreDropped1) {
                meshcoreDropped1.style.animation = 'none';
                setTimeout(() => {
                    meshcoreDropped1.style.animation = 'meshcore-dropped-1 15s forwards';
                }, 10);
            }
            
            if (meshcoreDropped2) {
                meshcoreDropped2.style.animation = 'none';
                setTimeout(() => {
                    meshcoreDropped2.style.animation = 'meshcore-dropped-2 15s forwards';
                }, 10);
            }
            
            if (routeLinkAC) {
                routeLinkAC.style.animation = 'none';
                setTimeout(() => {
                    routeLinkAC.style.animation = 'link-appear 15s forwards';
                }, 10);
            }
            
            if (routeLinkCE) {
                routeLinkCE.style.animation = 'none';
                setTimeout(() => {
                    routeLinkCE.style.animation = 'link-appear 15s forwards';
                }, 10);
            }
            
            // Reset phase indicators
            if (phase1Text && phase2Text && phase3Text) {
                phase1Text.classList.add('active');
                phase2Text.classList.remove('active');
                phase3Text.classList.remove('active');
                
                // Set up phase transitions
                setTimeout(() => {
                    phase1Text.classList.remove('active');
                    phase2Text.classList.add('active');
                }, 3750); // 25% of 15s
                
                setTimeout(() => {
                    phase2Text.classList.remove('active');
                    phase3Text.classList.add('active');
                }, 6000); // 40% of 15s
            }
        };
        
        // Reset all animations when they come into view
        const resetAnimations = () => {
            resetMeshtasticAnimations();
            resetMeshcoreAnimations();
        };
        
        // Setup intersection observer to restart animations when visible
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    resetAnimations();
                }
            });
        }, { threshold: 0.5 });
        
        observer.observe(routingDiagram);
        
        // Also restart animations when the routing accordion item is opened
        const routingAccordionItem = document.querySelector('.accordion-item:nth-child(1)');
        if (routingAccordionItem) {
            routingAccordionItem.addEventListener('click', () => {
                setTimeout(resetAnimations, 300);
            });
        }
    }
}); 