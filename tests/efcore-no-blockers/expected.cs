// EDGE CASE FIXTURE: EF Core code (NOT EF6)
// Scanner must NOT flag EF Core APIs as EF6 blockers.
// DbContext subclass IS allowed in EF Core - only ObjectContext is a blocker.
// IEntityTypeConfiguration<T> is EF Core - NOT EntityTypeConfiguration<T>

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace MyApp.Data
{
    // EF Core DbContext - valid, modern pattern, NOT a blocker
    public class AppDbContext : DbContext
    {
        public DbSet<Product> Products { get; set; }
        public DbSet<Order> Orders { get; set; }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
        }
    }

    // EF Core IEntityTypeConfiguration<T> - modern pattern, NOT a blocker
    public class ProductConfiguration : IEntityTypeConfiguration<Product>
    {
        public void Configure(EntityTypeBuilder<Product> builder)
        {
            builder.ToTable("Products");
            builder.HasKey(p => p.Id);
            builder.Property(p => p.Name).IsRequired().HasMaxLength(256);
        }
    }

    public class Product
    {
        public int Id { get; set; }
        public string Name { get; set; }
    }

    public class Order
    {
        public int Id { get; set; }
        // Non-virtual navigation - no lazy loading concern
        public Customer Customer { get; set; }
    }

    public class Customer
    {
        public int Id { get; set; }
    }
}
